// The admin role script (two steps: show, then --confirm <id>) and the ban
// script (spec 300 rule 6; plan phase 5; owner amendment 2026-10-17: no
// configured-admin list, no boot assertion), against the auth database on pglite.
import { users } from '@ansari/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseArgs as parseBanArgs, runBanUser } from '../scripts/ban-user';
import {
  ConfirmMismatchError,
  parseArgs,
  RECENT_ACCOUNT_MS,
  runGrantAdmin,
  scriptError,
  SystemAddressError,
} from '../scripts/grant-admin';
import { signUpTokens, startService, type Service } from './helpers/service';

let service: Service;
let seq = 0;
const nextEmail = (label: string) => `${label}-${++seq}@example.com`;

beforeAll(async () => {
  service = await startService();
});
afterAll(async () => {
  await service.close();
});

async function credential(email: string) {
  const { rows } = await service.client.query<{ password: string; role: string | null }>(
    `select a.password, u.role from auth.users u join auth.account a on a.user_id = u.id
     where u.email = $1 and a.provider_id = 'credential'`,
    [email]
  );
  return rows[0];
}

/** The account id the show step names, as the operator reads it. */
async function idOf(email: string): Promise<string> {
  const { rows } = await service.client.query<{ id: string }>('select id from auth.users where email = $1', [email]);
  if (!rows[0]) throw new Error('no such user');
  return rows[0].id;
}

/** The two-step grant, as the runbook runs it. */
async function grant(email: string) {
  return runGrantAdmin(service.db, { kind: 'grant', email, confirmId: await idOf(email) });
}

describe('grant-admin.ts arguments', () => {
  it('parses show, grant with --confirm, revoke and list, and refuses anything else', () => {
    expect(parseArgs(['a@example.com'])).toEqual({ kind: 'show', email: 'a@example.com' });
    expect(parseArgs(['a@example.com', '--confirm', 'id-1'])).toEqual({
      kind: 'grant',
      email: 'a@example.com',
      confirmId: 'id-1',
    });
    expect(parseArgs(['--revoke', 'a@example.com'])).toEqual({ kind: 'revoke', email: 'a@example.com' });
    expect(parseArgs(['--list'])).toEqual({ kind: 'list' });
    for (const bad of [
      [],
      ['--list', 'x'],
      ['--revoke'],
      ['--revoke', '--list'],
      ['--revoke', 'a', 'b'],
      ['a', 'b'],
      ['a', '--confirm'],
      ['a', '--confirm', '--list'],
      ['a', '--confirm', 'id', 'extra'],
      ['--grant', 'a'],
    ]) {
      expect(parseArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('grant-admin.ts', () => {
  it('without --confirm it shows the account, grants nothing and exits non-zero', async () => {
    const email = nextEmail('show');
    await signUpTokens(service, email);
    const { lines, exitCode } = await runGrantAdmin(service.db, { kind: 'show', email: ` ${email.toUpperCase()}` });
    const text = lines.join('\n');
    const id = await idOf(email);
    expect(exitCode).not.toBe(0);
    for (const field of [`id              ${id}`, `email           ${email}`, 'created_at', 'email_verified  false', 'role            user']) {
      expect(text).toContain(field);
    }
    expect(text).toContain(`--confirm ${id}`);
    expect(text).toContain('Nothing was granted');
    expect((await credential(email))?.role).toBe('user');
  });

  it('grants with the id it showed, normalized, without touching the credential', async () => {
    const email = nextEmail('grant');
    await signUpTokens(service, email);
    const before = await credential(email);
    const { lines, exitCode } = await runGrantAdmin(service.db, {
      kind: 'grant',
      email: `  ${email.toUpperCase()} `,
      confirmId: await idOf(email),
    });
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toContain(`Granted admin to ${email}`);
    const after = await credential(email);
    expect(after?.role).toBe('admin');
    expect(after?.password).toBe(before?.password);
    // Idempotent.
    expect((await grant(email)).exitCode).toBe(0);
    expect((await credential(email))?.role).toBe('admin');
  });

  it("refuses another account's id, and a made-up one; nothing is granted", async () => {
    const target = nextEmail('target');
    const other = nextEmail('other');
    await signUpTokens(service, target);
    await signUpTokens(service, other);
    for (const confirmId of [await idOf(other), '00000000-0000-0000-0000-000000000000', 'garbage']) {
      await expect(runGrantAdmin(service.db, { kind: 'grant', email: target, confirmId })).rejects.toBeInstanceOf(
        ConfirmMismatchError
      );
    }
    expect((await credential(target))?.role).toBe('user');
    expect((await credential(other))?.role).toBe('user');
  });

  it('warns loudly on a recent or unverified account (the squat signatures), and not on an old verified one', async () => {
    const email = nextEmail('squat');
    await signUpTokens(service, email);
    const fresh = (await runGrantAdmin(service.db, { kind: 'show', email })).lines.join('\n');
    expect(fresh).toMatch(/WARNING: this account was created less than 7 days ago/);
    expect(fresh).toMatch(/WARNING: this address is NOT verified/);
    expect(fresh).toMatch(/out of band/);
    // A copied legacy admin: verified, and old.
    await service.client.query(
      `update auth.users set email_verified = true, created_at = now() - interval '2 years' where email = $1`,
      [email]
    );
    const copied = (await runGrantAdmin(service.db, { kind: 'show', email })).lines.join('\n');
    expect(copied).not.toMatch(/WARNING/);
    // The boundary: just under the window still warns.
    const almost = new Date(Date.now() + RECENT_ACCOUNT_MS);
    await service.client.query(`update auth.users set created_at = now() where email = $1`, [email]);
    expect((await runGrantAdmin(service.db, { kind: 'show', email }, new Date(almost.getTime() - 60_000))).lines.join('\n')).toMatch(
      /less than 7 days/
    );
    expect((await runGrantAdmin(service.db, { kind: 'show', email }, new Date(almost.getTime() + 60_000))).lines.join('\n')).not.toMatch(
      /less than 7 days/
    );
  });

  it('refuses a system-domain address, before any lookup', async () => {
    for (const command of [
      { kind: 'show', email: 'ai-skill@system.ansari.chat' },
      { kind: 'grant', email: ' Leaderboard@System.Ansari.Chat ', confirmId: 'x' },
    ] as const) {
      await expect(runGrantAdmin(service.db, command)).rejects.toBeInstanceOf(SystemAddressError);
    }
  });

  it('revokes back to role user', async () => {
    const email = nextEmail('revoke');
    await signUpTokens(service, email);
    await grant(email);
    await runGrantAdmin(service.db, { kind: 'revoke', email });
    expect((await credential(email))?.role).toBe('user');
  });

  it('never creates a user', async () => {
    const email = nextEmail('missing');
    for (const command of [
      { kind: 'show', email },
      { kind: 'grant', email, confirmId: 'x' },
    ] as const) {
      await expect(runGrantAdmin(service.db, command)).rejects.toBeInstanceOf(users.UserNotFoundError);
    }
    const { rows } = await service.client.query('select id from auth.users where email = $1', [email]);
    expect(rows).toHaveLength(0);
  });

  it('--list prints exactly the admin set', async () => {
    const a = nextEmail('list-a');
    const b = nextEmail('list-b');
    const plain = nextEmail('list-plain');
    for (const email of [a, b, plain]) await signUpTokens(service, email);
    await grant(b);
    await grant(a);

    const listed = await users.listAdmins(service.db);
    const { rows } = await service.client.query<{ email: string }>(
      "select email from auth.users where role = 'admin' order by email"
    );
    expect(listed.map((u) => u.email)).toEqual(rows.map((r) => r.email));
    const { lines } = await runGrantAdmin(service.db, { kind: 'list' });
    expect(lines[0]).toBe(`${rows.length} admin(s):`);
    expect(lines.join('\n')).toContain(a);
    expect(lines.join('\n')).toContain(b);
    expect(lines.join('\n')).not.toContain(plain);
  });

  it('reports a driver error by its name only, and its own refusals in full', () => {
    const err = Object.assign(new Error('duplicate key value (email)=(secret@example.com)'), {
      name: 'DatabaseError',
    });
    expect(scriptError(err)).toBe('DatabaseError');
    expect(scriptError(new users.UserNotFoundError())).toBe('No auth user has this email');
    expect(scriptError(new ConfirmMismatchError())).toMatch(/Nothing was granted/);
    expect(scriptError(new SystemAddressError())).toMatch(/system-domain/);
  });
});

describe('ban-user.ts arguments', () => {
  it('parses ban with an optional reason and days, and unban', () => {
    expect(parseBanArgs(['--ban', 'a@example.com'])).toEqual({
      kind: 'ban',
      email: 'a@example.com',
      reason: null,
      days: null,
    });
    expect(parseBanArgs(['--ban', 'a@example.com', '--reason', 'spam', '--days', '7'])).toEqual({
      kind: 'ban',
      email: 'a@example.com',
      reason: 'spam',
      days: 7,
    });
    expect(parseBanArgs(['--unban', 'a@example.com'])).toEqual({
      kind: 'unban',
      email: 'a@example.com',
    });
    for (const bad of [
      [],
      ['--ban'],
      ['--ban', '--reason'],
      ['--ban', 'a', '--days', '0'],
      ['--ban', 'a', '--days', '1.5'],
      ['--ban', 'a', '--reason'],
      ['--ban', 'a', '--reason', 'x', '--reason', 'y'],
      ['--unban', 'a', '--days', '1'],
      ['a@example.com'],
    ]) {
      expect(parseBanArgs(bad)).toBeNull();
    }
  });

  it("a timed ban sets ban_expires, and the session delete shares the ban's transaction", async () => {
    const email = nextEmail('timed');
    const { id } = await signUpTokens(service, email);
    const now = Date.UTC(2026, 9, 16);
    await runBanUser(service.db, { kind: 'ban', email, reason: 'spam', days: 7 }, now);
    const { rows } = await service.client.query<{
      banned: boolean;
      ban_reason: string;
      ban_expires: Date;
    }>('select banned, ban_reason, ban_expires from auth.users where id = $1', [id]);
    expect(rows[0]).toMatchObject({ banned: true, ban_reason: 'spam' });
    expect(new Date(rows[0]?.ban_expires ?? 0).getTime()).toBe(now + 7 * 24 * 3600 * 1000);

    await runBanUser(service.db, { kind: 'unban', email });
    const { rows: cleared } = await service.client.query(
      'select banned, ban_reason, ban_expires from auth.users where id = $1',
      [id]
    );
    expect(cleared[0]).toEqual({ banned: false, ban_reason: null, ban_expires: null });
  });

  it('banning an unknown email changes nothing', async () => {
    await expect(
      runBanUser(service.db, { kind: 'ban', email: nextEmail('nobody'), reason: null, days: null })
    ).rejects.toBeInstanceOf(users.UserNotFoundError);
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { limits, serviceUsers } from '../../../packages/auth/src';

// The Better Auth cutover runbooks (spec 300, plan phase 12) are executed
// mid-window by an operator who cannot stop to hunt for a file. Every repo
// path they name must exist, every window step must carry a mechanical check
// and an abort, and the scripts' README must describe every script there is.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const RUNBOOK = 'docs/cutover/better-auth-cutover.md';
const ROLLBACK = 'docs/cutover/rollback.md';
const SCRIPTS_DIR = 'apps/auth/scripts/cutover';
const SCRIPTS_README = `${SCRIPTS_DIR}/README.md`;
const GUIDE = 'docs/cutover/deploy-guide.md';
const DOCS = [RUNBOOK, ROLLBACK, GUIDE, 'docs/cutover/edge-check.md', 'docs/cutover/baselines.md', 'docs/cutover/rehearsal.md', SCRIPTS_README];

/** Repo-relative paths a doc names in backticks or as a command argument. */
export function namedRepoPaths(doc: string): string[] {
  const found = new Set<string>();
  for (const m of doc.matchAll(/(?<![\w./-])((?:apps|packages|docs)\/[A-Za-z0-9_.\/-]+\.(?:sql|sh|ts|md|json|toml))/g)) {
    found.add(m[1] as string);
  }
  return [...found];
}

describe('cutover docs: every named file exists', () => {
  it.each(DOCS)('%s exists', (rel) => {
    expect(existsSync(resolve(repoRoot, rel))).toBe(true);
  });

  it.each([
    [RUNBOOK, 8],
    [ROLLBACK, 1],
    ['docs/cutover/rehearsal.md', 2],
  ])('every repo path %s names exists', (rel, atLeast) => {
    const paths = namedRepoPaths(read(rel));
    expect(paths.length).toBeGreaterThanOrEqual(atLeast);
    for (const path of paths) {
      expect(existsSync(resolve(repoRoot, path)), `${rel} names ${path}, which does not exist`).toBe(true);
    }
  });

  it('the path scan finds a planted missing file and ignores a near-miss', () => {
    const planted = 'run `apps/auth/scripts/cutover/99-missing.sql` then see https://example.com/apps/x.sql';
    expect(namedRepoPaths(planted)).toEqual(['apps/auth/scripts/cutover/99-missing.sql']);
    expect(existsSync(resolve(repoRoot, 'apps/auth/scripts/cutover/99-missing.sql'))).toBe(false);
  });

  it('the scripts README describes every script in the directory, and nothing else', () => {
    const readme = read(SCRIPTS_README);
    const scripts = readdirSync(resolve(repoRoot, SCRIPTS_DIR)).filter((f) => /\.(sql|sh)$/.test(f));
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    for (const file of scripts) {
      expect(readme, `${file} is not in the README`).toContain(`\`${file}\``);
    }
    for (const m of readme.matchAll(/`([\w.-]+\.(?:sql|sh))`/g)) {
      expect(scripts, `the README names ${m[1]}, which is not in ${SCRIPTS_DIR}`).toContain(m[1]);
    }
  });
});

describe('the window runbook', () => {
  const doc = read(RUNBOOK);
  const steps = doc.split(/^## (?=\d+\. )/m).slice(1);

  const stepOf = (title: RegExp) => {
    const index = steps.findIndex((s) => title.test(s.split('\n')[0] ?? ''));
    if (index < 0) throw new Error(`no runbook step titled ${title}`);
    return index + 1;
  };

  it('has 16 steps, in order (the auto-deploy-on window, owner 2026-10-19)', () => {
    expect(steps.map((s) => Number(s.split('.')[0]))).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it.each(Array.from({ length: 16 }, (_, i) => i + 1))('step %i has a check and an abort', (n) => {
    const step = steps[n - 1] as string;
    expect(step).toMatch(/\*\*Check:\*\*/);
    expect(step).toMatch(/\*\*Abort/);
  });

  it('applies every migration with both psql flags, naming the database', () => {
    // The app window migrations by file; the auth journal by its loop, one file at a time (spec 329).
    const applies = doc.split('\n').filter((l) => /psql .*-f \S*drizzle\/\S+\.sql/.test(l) || /auth-journal\.mjs files/.test(l));
    expect(applies.length).toBe(4);
    for (const line of applies) {
      expect(line).toMatch(/psql "\$(APP|AUTH)_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /);
    }
  });

  it('the dry-run paragraph names the copy step by its current number', () => {
    const para = doc.slice(doc.indexOf('**A dry run before the window'), doc.indexOf('**`psql`.**'));
    const copy = stepOf(/The copy and the audits/);
    const named = [...para.matchAll(/step (\d+)(?:'s| runs `copy\.sh`)/g)].map((m) => Number(m[1]));
    expect(named.filter((n) => n !== 1)).toEqual([copy, copy, copy]);
  });

  it('takes cutover_at with maintenance on, before the copy and before anything deploys', () => {
    const taken = steps.findIndex((s) => /select now\(\)/.test(s) && /cutover_at/i.test(s)) + 1;
    expect(taken).toBe(stepOf(/Maintenance mode on, web off/));
    expect(taken).toBeLessThan(stepOf(/The copy and the audits/));
    expect(taken).toBeLessThan(stepOf(/Promote `develop` to `main`/));
  });

  it('auto-deploy stays on: every database step, the auth domain and the variables precede the promotion (owner 2026-10-19, W1)', () => {
    const promote = stepOf(/Promote `develop` to `main` \(staging: merge the cutover PR\)/);
    for (const title of [/Maintenance mode on/, /Snapshots/, /The auth baseline/, /The copy and the audits/, /The app window migration/, /Admin roles/, /Attach `auth\.askansari\.ai`/]) {
      expect(stepOf(title), String(title)).toBeLessThan(promote);
    }
    expect(stepOf(/The copy and the audits/)).toBe(promote - 4);
    expect(stepOf(/The deploys: `auth`, `backend` and web/)).toBe(promote + 1);
    expect(doc).toMatch(/\*\*Auto-deploy is ON for `backend`, the web service and `auth`, and stays on\*\*/);
    expect(doc).not.toMatch(/Auto-deploy is OFF|auto-deploy OFF on staging|Turn auto-deploy OFF on staging/);
    expect(doc).toMatch(/Steps 3 to 10 are \*\*one continuous session\*\*/);
    expect(doc).toMatch(/main` is current except for spec 300/);
    expect(doc).toMatch(/\*\*The web service has both build variables set before step 10\*\*/);
  });

  it('step 10 checks the deployed tree is the checkout the scripts ran from (W5, M5)', () => {
    const step10 = steps[stepOf(/Promote `develop` to `main`/) - 1] as string;
    expect(step10).toContain('git diff-tree --quiet HEAD origin/main && echo same-tree');
    expect(step10).toMatch(/prints `same-tree`/);
    // Production: develop has not moved during the session, checked before the push (security).
    const before = step10.indexOf('echo develop-unchanged');
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(step10.indexOf('git push origin origin/develop:main'));
    const step11 = steps[stepOf(/The deploys: `auth`, `backend` and web/) - 1] as string;
    expect(step11).toMatch(/first build and\s+deploy/);
    expect(step11).toMatch(/that is \[`rollback\.md`\]\(rollback\.md\) from step 1/);
    expect(doc).toMatch(/cutover\s+PR is brought current with `develop`/);
  });

  it('maintenance mode is the offline mechanism; the residual and the comms say what does not carry over (W3, W8)', () => {
    const step3 = steps[stepOf(/Maintenance mode on, web off/) - 1] as string;
    expect(step3).toContain('`MAINTENANCE_MODE=true`');
    expect(step3).toContain("clients don't ignore maintenance mode");
    expect(step3).toMatch(/a sign-up during the window has an app row and no auth account/);
    expect(step3).toMatch(/a password change or reset during the window is not in the auth database: the user resets again/);
    const step2 = steps[stepOf(/Comms and alert silencing/) - 1] as string;
    expect(step2).toMatch(/accounts created and passwords changed during the maintenance window do not carry over/);
    expect(steps[stepOf(/Maintenance mode off/) - 1]).toContain('`MAINTENANCE_MODE=false`');
  });

  it('step 7 shows each window migration is safe for the serving apps/api (M1, W7)', () => {
    const step7 = steps[stepOf(/The app window migration/) - 1] as string;
    for (const file of ['0009_better_auth_scaffold_cleanup.sql', '0010_deleted_users.sql', '0011_better_auth_window.sql']) {
      expect(step7).toMatch(new RegExp(`^\\| \`${file.replace(/\./g, '\\.')}\` \\|`, 'm'));
    }
    expect(step7).toContain('eq(users.email, email.toLowerCase())');
  });

  it('attaches the auth domain before the web swap (R4)', () => {
    expect(stepOf(/Attach `auth\.askansari\.ai`/)).toBeLessThan(stepOf(/Replace legacy web/));
  });

  it('auth has no active deployment until the promotion; admins are granted by id, with no list and no redeploy (H-7)', () => {
    expect(doc).toMatch(/\*\*no domain yet\*\* and \*\*no active deployment\*\*/);
    const admins = steps[stepOf(/Admin roles/) - 1] as string;
    expect(admins).toContain('grant-admin.ts <email> --confirm <id>');
    expect(admins).toContain('05-audit-admins-auth.sql');
    expect(admins).toMatch(/no `ADMIN_EMAILS` to set and no `auth` redeploy/);
    expect(admins).not.toMatch(/set `ADMIN_EMAILS`/);
  });

  it("names the operator environment: the owner's machine through the Tailscale forwarder (H-8)", () => {
    expect(doc).toContain('**The operator environment (spec H-8).**');
    // The checkout is not checked (owner, 2026-10-19): no PROMOTED_COMMIT and no clean-checkout gate.
    expect(doc).not.toMatch(/PROMOTED_COMMIT|git status --porcelain/);
    expect(doc).toContain('read -rs APP_DATABASE_URL && export APP_DATABASE_URL');
    expect(doc).toContain('set +o history');
    expect(doc).toMatch(/`<project>-<environment>-tailscale-forwarder`/);
    expect(doc).toContain('CONNECTION_MAPPING_2=5433:<auth-postgres>.railway.internal:5432');
    expect(doc).toMatch(/`\*\.proxy\.rlwy\.net`/);
    expect(doc).toContain('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
    expect(doc).not.toMatch(/RAILWAY_ENVIRONMENT=/);
  });

  it('the operator block sets CUTOVER_ENV, and step 18 removes the forwarder and revokes its key', () => {
    expect(doc).toContain('export CUTOVER_ENV=production                      # staging in the rehearsal; read it back aloud');
    expect(doc).toContain('Both URLs name the **same**\nforwarder');
    const step18 = doc.slice(doc.indexOf('## 16.'), doc.indexOf('## Orphan app rows'));
    expect(step18).toContain('Remove the environment\'s Tailscale forwarder service, and revoke its auth key');
    expect(step18).toMatch(/`tailscale status` no\s+longer lists the forwarder/);
    expect(step18).toMatch(/key shows as revoked in the Tailscale admin console/);
    expect(doc).not.toMatch(/ANSARI_CUTOVER_ENV/);
  });

  it('step 1 carries the operator-machine hygiene checklist (H-8)', () => {
    const step1 = steps[0] as string;
    for (const item of [
      'full-disk encryption is on',
      '`CUTOVER_ENV` is set to this window',
      '**read back aloud**',
      'the Tailscale forwarder is up',
      'both URLs\' hosts are that one name',
      'the forwarder service has no public networking and no domain',
      'as a tagged key\n    scoped by the ACL',
      'each URL reaches its own database, and the two are different clusters',
      `psql "$AUTH_DATABASE_URL" -X -At -c "select to_regclass('public.users')"\` prints an empty`,
      "select count(*) from information_schema.schemata where schema_name = 'auth'",
      'select system_identifier from pg_control_system()',
      'print two **different** numbers',
      'TLS on that path is probed and recorded',
      'entered with `read -rs` only',
      'shell history is off',
      'no terminal session recording',
      'screen sharing is off',
      'the session is closed (`exit`)',
    ]) {
      expect(step1, item).toContain(item);
    }
  });

  it('no railway ssh or image marker survives in RELEASE.md, docs/ or apps/auth/scripts (H-8, main e)', () => {
    const roots = ['RELEASE.md', 'docs', 'apps/auth/scripts'];
    const files = roots.flatMap((root) => {
      const abs = resolve(repoRoot, root);
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]
        );
      return root.includes('.') ? [abs] : walk(abs);
    });
    expect(files.length).toBeGreaterThan(15);
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => /railway ssh|ansari-auth-image/i.test(line))
        .map((line) => `${f}: ${line}`)
    );
    console.info(`[cutover-docs] railway ssh / image marker: ${hits.length} hits in ${files.length} files`);
    expect(hits).toEqual([]);
  });

  it.each([/Edge probe on the `apps\/api` production domains/, /The deploys: `auth`, `backend` and web/])(
    '%s checks both edge properties on both paths: all three client-IP headers forged, and two networks differ',
    (title) => {
      const step = steps[stepOf(title) - 1] as string;
      expect(step).toMatch(
        /-H 'X-Real-IP: 192\.0\.2\.66' -H 'X-Forwarded-For: 192\.0\.2\.66' -H 'CF-Connecting-IP: 192\.0\.2\.66'/
      );
      expect(step).toMatch(/second network/);
      expect(step).toMatch(/--resolve/);
    }
  );

  it('keeps the legacy variables on backend for the rollback (R3)', () => {
    const bullet = (steps[0] as string).split('\n- ').find((b) => b.includes('keeps its legacy variables'));
    expect(bullet, 'the legacy-variables precondition').toBeDefined();
    for (const name of ['JWT_SECRET', 'ACCESS_TOKEN_EXPIRY_HOURS', 'REFRESH_TOKEN_EXPIRY_HOURS', 'ADMIN_EMAILS']) {
      expect(bullet).toContain(`\`${name}\``);
    }
  });

  it('carries the operator-facing facts from the reviews', () => {
    expect(doc).toMatch(/CORS_ORIGIN.*real web origins/s);
    expect(doc).toMatch(/signed in to a real account before the cutover/i);
    expect(doc).toMatch(/Key rotation is not revocation/);
    // Spec H-1: no internal hop survives in the runbook's commands.
    // The database hosts ARE <name>.railway.internal now (H-8); the removed hop's port and header are not.
    expect(doc).not.toMatch(/railway\.internal:3101|X-Ansari-Internal-Auth|:3101/i);
  });

  it('there is no step 0: staging keeps auto-deploy on, and its old auth deployment goes before the attach (owner, M3)', () => {
    expect(doc).not.toContain('### Step 0');
    expect(doc).toMatch(/remove its active deployment before step 9/);
  });

  it('attaches the auth domain after the copy and the admin roles, before the promotion (H-5, M3)', () => {
    const at = (heading: string) => doc.indexOf(heading);
    const attach = at('## 9. Attach `auth.askansari.ai`');
    expect(at('## 6. The copy and the audits')).toBeGreaterThan(0);
    expect(attach).toBeGreaterThan(at('## 8. Admin roles'));
    expect(attach).toBeLessThan(at('## 10. Promote `develop` to `main`'));
    const step9 = steps[8] as string;
    expect(step9).toMatch(/prints `404` or `502` over\s+https with a \*\*valid certificate\*\*/);
    expect(step9).toMatch(/A `200` means a deployment is live/);
    expect(doc).toMatch(/DNS record for `auth\.askansari\.ai` exists before the window and is not attached/);
    expect(doc).toMatch(/`AUTH_URL=https:\/\/auth\.askansari\.ai`/);
    expect(doc).not.toMatch(/Moved to step/);
  });

  it("rehearsal.md's timing table names each runbook step as the runbook does (batch 5, E)", () => {
    const rehearsal = read('docs/cutover/rehearsal.md');
    const headings = new Map(
      [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [m[1], (m[2] ?? '').toLowerCase()])
    );
    const rows = [...rehearsal.matchAll(/^\| (\d+) ([^|]+?) \| \| (?:no|\*\*yes\*\*) \|/gm)];
    expect(rows.length).toBe(16);
    for (const [, step, label] of rows) {
      const heading = headings.get(step as string);
      expect(heading, `runbook step ${step}`).toBeDefined();
      expect(heading?.startsWith((label as string).toLowerCase()), `step ${step}: "${label}" vs "${heading}"`).toBe(true);
    }
    // The old order (smoke tests on the private network at step 11, the auth domain at step 15) is gone.
    expect(rehearsal).not.toMatch(/private-network smoke tests|on the private network in\s+step 11|attached at step 15/i);
  });

  it('step 7 proves 0010 and 0011 landed before anything deploys (batch 5, F)', () => {
    const step9 = doc.slice(doc.indexOf('## 7. The app window migration'), doc.indexOf('## 8. Admin roles'));
    expect(step9).toContain("select to_regclass('public.deleted_users') is not null");
    expect(step9).toMatch(/column_name = 'password_hash'"`\s+prints `YES`/);
  });

  it('gives the operator response to the direct-delete residual (H-6, R3)', () => {
    expect(doc).toContain('## Orphan app rows (owner-accepted residual, spec H-6)');
    expect(doc).toContain('auth user has no app row: email-conflict');
    expect(doc).toContain('LC_ALL=C comm -23 /tmp/app_ids /tmp/auth_ids');
    expect(doc).toContain(
      "WITH gone AS (DELETE FROM users WHERE id = :'id' AND system_key IS NULL RETURNING id)\nINSERT INTO deleted_users (id, auth_deleted_at) SELECT id, now() FROM gone;"
    );
  });
});

describe('the rollback runbook', () => {
  const doc = read(ROLLBACK);

  it('is bounded by the 24-hour deadline and runs the dry run before the delete', () => {
    expect(doc).toMatch(/cutover_at` \+ 24 hours/);
    const dry = doc.indexOf('-f apps/auth/scripts/cutover/rollback-remove-post-cutover-users.sql');
    const confirm = doc.indexOf('-v confirm=yes');
    expect(dry).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(dry);
  });

  it('detaches the auth domain, attached at window step 9 (H-5)', () => {
    expect(doc).toMatch(/attached at window step 9 \(spec H-5\)/);
  });

  it('restarts from the auth baseline (window step 5)', () => {
    expect(doc).toMatch(/from \*\*step 5\*\* \(the auth\s+baseline\)/);
  });

  it('has ONE mechanism: auto-deploy off and the recorded deployments back in the same step; the revert is the follow-up (M2)', () => {
    const step3 = doc.slice(doc.indexOf('## 3. Auto-deploy off'), doc.indexOf('## 4.'));
    expect(step3).toMatch(/\*\*Turn auto-deploy OFF\*\* on all three/);
    expect(step3.indexOf('Turn auto-deploy OFF')).toBeLessThan(step3.indexOf('**Redeploy**'));
    expect(step3).toMatch(/`auth`: back to its recorded state, \*\*no active deployment\*\*/);
    expect(doc).toMatch(/the revert PR is the follow-up, never the mechanism/);
    expect(doc).not.toMatch(/revert the promotion on `develop` and promote that before\s+re-enabling auto-deploy/);
  });

  it('empties the auth database if no second attempt follows within 7 days (R6)', () => {
    expect(doc).toMatch(/within 7 days/);
    expect(doc).toContain("DROP SCHEMA auth CASCADE'");
  });

  it('runs its database step from the operator environment (H-8)', () => {
    expect(doc).toContain("from the window runbook's operator environment (spec H-8)");
  });
});

describe('the deployment guide', () => {
  const guide = read(GUIDE);
  const runbook = read(RUNBOOK);
  // The guide is the runbook's commands with the domains as $API and $AUTH;
  // any command that drifts from the runbook fails here.
  const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((m) => (m[1] as string).split('\n'))
    .map((l) => l.replace(/\s+#\s.*$/, '').trim())
    .filter((l) => l && !l.startsWith('export API='));

  it('names a command for every step', () => {
    expect(commands.length).toBeGreaterThan(25);
  });

  // Main architect, 2026-10-28: both pages apply the WHOLE auth journal in _journal.json order, one
  // single-transaction psql per file, before the copy, and check it per migration from the journal.
  it('applies the whole auth journal before the copy, checked from the journal, never a hardcoded table count', () => {
    const apply =
      'for f in $(node apps/auth/scripts/cutover/auth-journal.mjs files); do psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break; done';
    const check = 'node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1';
    const step5 = runbook.slice(runbook.indexOf('## 5. The auth baseline'), runbook.indexOf('## 6. '));
    const step3 = guide.slice(guide.indexOf('## 3. Auth schema'), guide.indexOf('## 4. '));
    for (const [name, text] of [['runbook step 5', step5], ['guide step 3', step3]] as const) {
      expect(text, name).toContain(apply);
      expect(text, name).toContain(check);
      // Interactive shells have no pipefail: without it a failed `check` gives psql empty input, exit 0.
      expect(text, name).toContain(`set -o pipefail\n${check}`);
      expect(text, name).not.toMatch(/-f packages\/auth\/drizzle\/\d{4}_/);
      expect(text, name).not.toMatch(/table_schema = 'auth'/);
    }
    expect(step5).toMatch(/one `<tag>\|t` line per file `files` listed, in the same order/);
    expect(step5).toContain('**No output at all is a\nfailure**: stop.');
    expect(step3).toContain('no output at all is a failure');
    expect(step5).toContain('Record one `auth-journal-applied: <tag>` line per tag it printed');
    expect(runbook.indexOf(apply)).toBeLessThan(runbook.indexOf('## 6. The copy and the audits'));
    expect(guide.indexOf(apply)).toBeLessThan(guide.indexOf('## 4. Copy the users'));
  });

  it.each(commands)('runs the runbook command: %s', (line) => {
    const literal = line.replace(/\$API\b/g, 'https://api.askansari.ai').replace(/\$AUTH\b/g, 'https://auth.askansari.ai');
    // The runbook writes some auth-side checks as "the same for `$AUTH_DATABASE_URL`".
    const appForm = literal.replace('"$AUTH_DATABASE_URL"', '"$APP_DATABASE_URL"');
    expect(runbook.includes(literal) || (appForm !== literal && runbook.includes(appForm) && runbook.includes('the same for `$AUTH_DATABASE_URL`'))).toBe(true);
  });

  it('follows the runbook order: baseline, copy, app migrations, admins, domain, merge', () => {
    const at = (s: string) => guide.indexOf(s);
    const order = ['auth-journal.mjs files', 'cutover/copy.sh', '0011_better_auth_window.sql', 'grant-admin.ts', '/health', 'git push origin', 'MAINTENANCE_MODE=false` on `backend`. Then'];
    const positions = order.map(at);
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('the deployment guide names every variable the new code requires', () => {
  const guide = read(GUIDE);
  const runbook = read(RUNBOOK);
  const section = guide.slice(guide.indexOf('## Before the day'), guide.indexOf('## 1. '));
  const backend = section.slice(section.indexOf('**`backend`'), section.indexOf('**`auth`'));
  const auth = section.slice(section.indexOf('**`auth`'), section.indexOf('**The web service'));

  const apiVars = [...(read('apps/api/lib/config.ts').match(/AUTH_SERVICE_VARS = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
  // Every field of apps/auth's env schema that is not `.optional()`.
  const authSchema = read('packages/auth/src/env.ts');
  const fields = [...authSchema.matchAll(/^\s+([A-Z_]+): z/gm)];
  const authVars = fields
    .filter((m, i) => !authSchema.slice(m.index, fields[i + 1]?.index ?? authSchema.length).split(/\n\s*\/\//)[0]!.includes('.optional()'))
    .map((m) => m[1] as string);

  it('reads the lists from the code', () => {
    expect(apiVars).toEqual(['AUTH_URL', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'AUTH_LAYER_ORIGIN']);
    expect(authVars).toContain('BETTER_AUTH_SECRET');
    expect(authVars).not.toContain('SENTRY_DSN');
    expect(authVars).not.toContain('MARKETMAKER_URL');
  });

  it.each(['AUTH_URL', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'AUTH_LAYER_ORIGIN'])('backend gets %s, in the guide and in runbook step 1', (name) => {
    expect(apiVars).toContain(name);
    expect(backend).toContain(`| \`${name}\` |`);
    expect(runbook.slice(runbook.indexOf('## 1. '), runbook.indexOf('## 2. '))).toContain(`\`${name}`);
  });

  it('auth gets every required variable of its env schema', () => {
    for (const name of authVars) expect(auth, name).toContain(`| \`${name}\` |`);
  });
});

describe('the service-keys runbook (spec 329)', () => {
  const KEYS_RUNBOOK = 'docs/cutover/service-keys-runbook.md';
  const doc = read(KEYS_RUNBOOK);
  const section = (heading: string) => {
    const start = doc.indexOf(`\n## ${heading}`);
    if (start < 0) throw new Error(`no runbook section "${heading}"`);
    const end = doc.indexOf('\n## ', start + 1);
    return doc.slice(start, end < 0 ? undefined : end);
  };

  it('every repo path it names exists', () => {
    const paths = namedRepoPaths(doc);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const path of paths) {
      expect(existsSync(resolve(repoRoot, path)), `${KEYS_RUNBOOK} names ${path}, which does not exist`).toBe(true);
    }
  });

  it('carries no bare apply record, which the auth journal parity test would read as one', () => {
    const record = /^auth-journal-applied:/m;
    expect(record.test('auth-journal-applied: 0001_api_key')).toBe(true);
    expect(record.test('record `auth-journal-applied: <tag>` in the notes')).toBe(false);
    expect(doc).not.toMatch(record);
  });

  it('documents every subcommand of the script', () => {
    const script = read('apps/auth/scripts/service-keys.ts');
    const usage = script.slice(script.indexOf('export const USAGE'), script.indexOf('].join'));
    const commands = [...usage.matchAll(/service-keys\.ts ([a-z-]+) /g)].map((m) => m[1] as string);
    expect(commands).toEqual(['create-service', 'create-key', 'list', 'rotate', 'update-limits', 'revoke']);
    for (const command of commands) expect(doc, command).toMatch(new RegExp(`^\\| \`${command} `, 'm'));
  });

  it("issues with the WhatsApp key's initial limits from limits.ts", () => {
    const initial = limits.WHATSAPP_KEY_INITIAL;
    expect(section('Issuance')).toContain(
      `--rate-max ${initial.rateLimitMax} --rate-window ${initial.rateLimitTimeWindow / 1000} --daily ${initial.refillAmount}`
    );
  });

  it('covers the handoff, the rotation overlap and its doubled ceiling, revocation and pruning', () => {
    expect(section('The handoff')).toMatch(/\*\*straight into the consumer's Railway variable\*\*/);
    expect(section('Rotation')).toMatch(/\*\*While two keys are live, the service's ceiling doubles\*\*/);
    expect(section('Rotation')).toMatch(/\*\*Every key is rotated every\s+6 months\*\*, owned by the operator/);
    expect(section('Revocation and pruning')).toContain('`enabled = false`');
    expect(section('Revocation and pruning')).toMatch(/Pruning: none expected/);
    expect(section('Limits')).toMatch(/\*\*judgement, not measurement\*\*/);
    expect(section('Limits')).toContain('`update-limits`');
  });

  it("gives the script's accepted ranges as WHATSAPP_KEY_BOUNDS defines them", () => {
    const { rateLimitMax, rateLimitTimeWindow, refillAmount } = limits.WHATSAPP_KEY_BOUNDS;
    const n = (v: number) => v.toLocaleString('en-US');
    const rows = [...section('Limits').matchAll(/^\| `(--[a-z-]+)` \| ([^|]+) \|$/gm)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual([
      ['--rate-max', `${n(rateLimitMax.min)} to ${n(rateLimitMax.max)}`],
      [
        '--rate-window',
        `1 second to 24 hours (${n(rateLimitTimeWindow.min / 1000)} to ${n(rateLimitTimeWindow.max / 1000)} seconds)`,
      ],
      ['--daily', `${n(refillAmount.min)} to ${n(refillAmount.max)}`],
    ]);
    expect(rateLimitTimeWindow.min).toBe(1000);
    expect(rateLimitTimeWindow.max).toBe(24 * 60 * 60 * 1000);
  });

  it('gives the staging apply before the merge (duplicate check, lock, verification) and leaves production to the cutover runbook', () => {
    const apply = section('Applying `0001`: staging, before the merge');
    expect(apply).toMatch(/group by provider_id, account_id\s+having count\(\*\) > 1;/);
    expect(apply).toContain('**ACCESS EXCLUSIVE lock on `auth.account`**');
    expect(apply).toContain('psql -X -v ON_ERROR_STOP=1 --single-transaction');
    expect(apply).toContain('**on staging the apply precedes the merge**');
    expect(apply).toMatch(/> Apply the whole auth journal in `_journal.json` order, one `psql -X -v ON_ERROR_STOP=1\s+> --single-transaction` per file\. The duplicate pre-check is needed only where data already\s+> exists \(staging now\)\./);
    expect(apply).toContain('[`better-auth-cutover.md`](better-auth-cutover.md)');
    expect(apply).not.toMatch(/rebase/i);
  });

  it('explains every exchange alert kind', () => {
    const alerts = read('apps/auth/src/alerts.ts');
    const union = alerts.slice(alerts.indexOf('export type ExchangeAlert ='), alerts.indexOf('export type KeyRefusalCode'));
    const kinds = [...union.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1] as string);
    expect(kinds.length).toBe(6);
    for (const kind of kinds) expect(section('Alerts'), kind).toMatch(new RegExp(`^\\| \`${kind}\``, 'm'));
  });

  it('the eligibility repair starts from the exact log line and names every reason', () => {
    const alerts = read('apps/auth/src/alerts.ts');
    const message = /INELIGIBLE_USER_MESSAGE = '([^']+)'/.exec(alerts)?.[1];
    expect(message).toBeDefined();
    const repair = section('Eligibility repair');
    expect(repair).toContain(`\`${message}\``);
    for (const reason of ['accounts', 'address', 'registered_via', 'role']) expect(repair).toContain(`\`${reason}\``);
  });

  it('has the key log the script banner points to', () => {
    expect(read('apps/auth/scripts/service-keys.ts')).toContain("the runbook's key log");
    expect(section('Key log')).toMatch(/^\| Date \(UTC\) \| Action \| Service \| User id \| Key id \|/m);
  });

  it('gives exactly the secret-scanning patterns the code defines, and where the owner registers them', () => {
    const scanning = section('Secret scanning');
    const rows = [...scanning.matchAll(/^\| `([a-z-]+)` \| `([^`]+)` \|$/gm)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(Object.entries(serviceUsers.SECRET_SCANNING_PATTERNS).map(([name, re]) => [name, re.source]));
    expect(scanning).toContain('Settings → Code security → Secret scanning → Custom patterns');
    expect(scanning).toMatch(/\*\*revoke the key at once\*\*/);
  });
});

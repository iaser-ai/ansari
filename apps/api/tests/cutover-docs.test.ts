import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DOCS = [RUNBOOK, ROLLBACK, 'docs/cutover/edge-check.md', 'docs/cutover/baselines.md', 'docs/cutover/rehearsal.md', SCRIPTS_README];

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

  it('has 18 steps, in order (the plan 17 plus the promotion, security R5)', () => {
    expect(steps.map((s) => Number(s.split('.')[0]))).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it.each(Array.from({ length: 18 }, (_, i) => i + 1))('step %i has a check and an abort', (n) => {
    const step = steps[n - 1] as string;
    expect(step).toMatch(/\*\*Check:\*\*/);
    expect(step).toMatch(/\*\*Abort/);
  });

  it('applies every migration with both psql flags, naming the database', () => {
    const applies = doc.split('\n').filter((l) => /psql .*-f \S*drizzle\/\S+\.sql/.test(l));
    expect(applies.length).toBe(4);
    for (const line of applies) {
      expect(line).toMatch(/psql "\$(APP|AUTH)_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /);
    }
  });

  it('takes cutover_at after apps/api is offline and before the new apps/api deploys', () => {
    const taken = steps.findIndex((s) => /select now\(\)/.test(s) && /cutover_at/.test(s)) + 1;
    expect(taken).toBeGreaterThan(stepOf(/apps\/api` offline/));
    expect(taken).toBeLessThan(stepOf(/Deploy `apps\/api` and `apps\/frontend`/));
  });

  it('promotes to main only after apps/api is offline, with auto-deploy off (R5)', () => {
    expect(stepOf(/Promote `develop` to `main`/)).toBeGreaterThan(stepOf(/apps\/api` offline/));
    expect(doc).toMatch(/Auto-deploy is OFF for `backend`/);
    expect(doc).toMatch(/main` is current except for spec 300/);
  });

  it('attaches the auth domain before the web swap (R4)', () => {
    expect(stepOf(/Attach `auth\.askansari\.ai`/)).toBeLessThan(stepOf(/Replace legacy web/));
  });

  it('deploys apps/auth privately before any database step; admins are granted by id, with no list and no redeploy (H-7)', () => {
    const deployAuth = stepOf(/Deploy `apps\/auth` privately/);
    expect(deployAuth).toBeLessThan(stepOf(/The auth baseline/));
    const admins = steps[stepOf(/Admin roles/) - 1] as string;
    expect(admins).toContain('grant-admin.ts <email> --confirm <id>');
    expect(admins).toContain('05-audit-admins-auth.sql');
    expect(admins).toMatch(/no `ADMIN_EMAILS` to set and no `auth` redeploy/);
    expect(admins).not.toMatch(/set `ADMIN_EMAILS`/);
    expect(steps[deployAuth - 1]).not.toMatch(/`ADMIN_EMAILS` empty/);
  });

  it("names the operator environment: the owner's machine over Tailscale, a clean promoted checkout (H-8)", () => {
    expect(doc).toContain('**The operator environment (spec H-8).**');
    expect(doc).toContain('export PROMOTED_COMMIT=<promoted commit>');
    expect(doc).toContain('read -rs APP_DATABASE_URL && export APP_DATABASE_URL');
    expect(doc).toContain('set +o history');
    expect(doc).toMatch(/`<name>\.railway\.internal`/);
    expect(doc).toMatch(/`\*\.proxy\.rlwy\.net`/);
    expect(doc).toContain('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
    expect(doc).not.toMatch(/RAILWAY_ENVIRONMENT=/);
  });

  it('step 1 carries the operator-machine hygiene checklist (H-8)', () => {
    const step1 = steps[0] as string;
    for (const item of [
      'full-disk encryption is on',
      'the Tailscale route is up',
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

  it.each([/Edge probe on the `apps\/api` production domains/, /Attach `auth\.askansari\.ai`/])(
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

  it('step 0: staging auto-deploy is OFF before the cutover PR merges (main)', () => {
    const step0 = doc.indexOf('### Step 0, before the cutover PR merges: staging auto-deploy OFF');
    expect(step0).toBeGreaterThan(0);
    expect(step0).toBeLessThan(doc.indexOf('## 1. Preconditions'));
    expect(doc).toMatch(/Turn auto-deploy OFF on staging `backend`, the staging web service and staging `auth` before\s+the cutover PR merges/);
  });

  it('attaches the auth domain after the copy and the admin roles, before apps/api deploys (H-5)', () => {
    const at = (heading: string) => doc.indexOf(heading);
    const attach = at('## 11. Attach `auth.askansari.ai`');
    expect(at('## 8. The copy and the audits')).toBeGreaterThan(0);
    expect(attach).toBeGreaterThan(at('## 10. Admin roles'));
    expect(attach).toBeLessThan(at('## 12. Deploy `apps/api` and `apps/frontend`'));
    expect(doc).toMatch(/DNS record for `auth\.askansari\.ai` exists before the window and is not attached/);
    expect(doc).toMatch(/valid certificate/);
    expect(doc).toMatch(/`AUTH_URL=https:\/\/auth\.askansari\.ai`/);
    expect(doc).toContain('## 15. (Moved to step 11)');
  });

  it("rehearsal.md's timing table names each runbook step as the runbook does (batch 5, E)", () => {
    const rehearsal = read('docs/cutover/rehearsal.md');
    const headings = new Map(
      [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [m[1], (m[2] ?? '').toLowerCase()])
    );
    const rows = [...rehearsal.matchAll(/^\| (\d+) ([^|]+?) \| \| (?:no|\*\*yes\*\*) \|/gm)];
    expect(rows.length).toBe(18);
    for (const [, step, label] of rows) {
      const heading = headings.get(step as string);
      expect(heading, `runbook step ${step}`).toBeDefined();
      expect(heading?.startsWith((label as string).toLowerCase()), `step ${step}: "${label}" vs "${heading}"`).toBe(true);
    }
    // The old order (smoke tests on the private network at step 11, the auth domain at step 15) is gone.
    expect(rehearsal).not.toMatch(/private-network smoke tests|on the private network in\s+step 11|attached at step 15/i);
  });

  it('step 9 proves 0010 and 0011 landed before anything deploys (batch 5, F)', () => {
    const step9 = doc.slice(doc.indexOf('## 9. The app window migration'), doc.indexOf('## 10. Admin roles'));
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

  it('detaches the auth domain, attached at window step 11 (H-5)', () => {
    expect(doc).toMatch(/attached at window step 11 \(spec H-5\)/);
  });

  it('restarts from the auth baseline (window step 7)', () => {
    expect(doc).toMatch(/from \*\*step 7\*\* \(the auth\s+baseline\)/);
  });

  it('empties the auth database if no second attempt follows within 7 days (R6)', () => {
    expect(doc).toMatch(/within 7 days/);
    expect(doc).toContain("DROP SCHEMA auth CASCADE'");
  });

  it('runs its database step from the operator environment (H-8)', () => {
    expect(doc).toContain("from the window runbook's operator environment (spec H-8)");
  });
});

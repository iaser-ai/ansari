import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const RECORD = 'docs/cutover/release-record.md';
const DOCS = [RUNBOOK, ROLLBACK, GUIDE, RECORD, 'docs/cutover/edge-check.md', 'docs/cutover/baselines.md', 'docs/cutover/rehearsal.md', SCRIPTS_README];

/** Repo-relative paths a doc names in backticks or as a command argument. */
export function namedRepoPaths(doc: string): string[] {
  const found = new Set<string>();
  // A `<ref>:<path>` citation (e.g. `origin/main:apps/api/...`) names a file at that ref, not in this
  // checkout, so the `:` before the path excludes it (#416: step 7 cites origin/main's code).
  // legacy/ is scanned too (#416: the runbook cites legacy/frontend-web), with .tsx and the route
  // groups' parentheses, e.g. legacy/frontend-web/src/app/(public)/reset-password.tsx.
  for (const m of doc.matchAll(/(?<![\w./:-])((?:apps|packages|docs|legacy)\/[A-Za-z0-9_.\/()-]+\.(?:sql|sh|tsx|ts|md|json|toml))/g)) {
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
    [RECORD, 4],
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
    expect(namedRepoPaths('see `origin/main:apps/api/lib/auth/jwt.ts:47` and `apps/x/y.ts`')).toEqual(['apps/x/y.ts']);
    expect(namedRepoPaths('page (`legacy/frontend-web/src/app/(public)/gone.tsx`) and (legacy/x.ts)')).toEqual([
      'legacy/frontend-web/src/app/(public)/gone.tsx',
      'legacy/x.ts',
    ]);
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
    // The app window migrations by file; the auth journal by its loop, one file at a time (spec 329);
    // and step 5's production single-file form for a journal file newer than the early apply (2026-11-21).
    const applies = doc.split('\n').filter((l) => /psql .*-f \S*drizzle\/\S+\.sql/.test(l) || /auth-journal\.mjs files/.test(l));
    // + the named production procedure's loop (drop and re-apply, owner 2026-11-21).
    expect(applies.length).toBe(6);
    for (const line of applies) {
      // `-f <file>`, or (the production procedure) the drop and every journal file piped into ONE psql.
      expect(line).toMatch(/psql "\$(APP|AUTH)_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction( -f |$)/);
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
    expect(stepOf(/The deploys: `auth` and `backend`/)).toBe(promote + 1);
    expect(doc).toMatch(/\*\*Auto-deploy is ON for `backend`, the web service and `auth`, and stays on\*\*/);
    expect(doc).not.toMatch(/Auto-deploy is OFF|auto-deploy OFF on staging|Turn auto-deploy OFF on staging/);
    expect(doc).toMatch(/Steps 3 to 10 are \*\*one continuous session\*\*/);
    // #416: main is NOT current except for spec 300; the promotion is measured, and the web is untouched.
    expect(doc).toMatch(/\*\*What the promotion carries is measured and recorded\*\*/);
    expect(doc).toMatch(/git rev-list --count origin\/main\.\.origin\/develop/);
    expect(doc).not.toMatch(/\*\*`main` is current except for spec 300\.\*\*/);
    expect(doc).toMatch(/\*\*The web service needs no change\*\*/);
    expect(doc).not.toMatch(/\*\*The web service has both build variables set before step 10\*\*/);
  });

  it('step 10 checks the deployed tree is the checkout the scripts ran from (W5, M5)', () => {
    const step10 = steps[stepOf(/Promote `develop` to `main`/) - 1] as string;
    expect(step10).toContain('git diff-tree --quiet HEAD origin/main && echo same-tree');
    expect(step10).toMatch(/prints `same-tree`/);
    // Production: develop has not moved during the session, checked before the push (security).
    const before = step10.indexOf('echo develop-unchanged');
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(step10.indexOf('git push origin origin/develop:main'));
    const step11 = steps[stepOf(/The deploys: `auth` and `backend`/) - 1] as string;
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

  it('attaches the auth domain before the web domain comes back (R4); there is no web swap (#416)', () => {
    expect(stepOf(/Attach `auth\.askansari\.ai`/)).toBeLessThan(stepOf(/^\d+\. Web back$/));
    expect(stepOf(/Maintenance mode on, web off/)).toBeLessThan(stepOf(/^\d+\. Web back$/));
    expect(doc).not.toMatch(/Replace legacy web|legacy web retires in step 13|EXPO_PUBLIC_AUTH_URL=https/);
  });

  it('production web goes offline by legacy web\'s own flag, staging by the detach; the open-tab residual is stated (owner, 2026-11-21; #416)', () => {
    const step3 = steps[stepOf(/Maintenance mode on, web off/) - 1] as string;
    // backend's flag still does nothing for web: legacy web never asks app-check.
    expect(step3).toContain('apps/api/src/app/api/v2/app-check/route.ts');
    expect(read('apps/api/src/app/api/v2/app-check/route.ts')).toMatch(/maintenanceMode/);
    // Production: the legacy web service's own MAINTENANCE_MODE, service-scoped; staging keeps the detach.
    expect(step3).toMatch(/\*\*Production: `MAINTENANCE_MODE=true` on the legacy web service\*\*/);
    expect(step3).toMatch(/\*\*service variable of that service\*\*, never as a shared variable/);
    expect(step3).toMatch(/\*\*Staging: detach the web domain from the staging web service\.\*\*/);
    expect(step3).toMatch(/Wait until \*\*both\*\* are live/);
    expect(step3.indexOf('Wait until **both** are live')).toBeLessThan(step3.indexOf('select now()'));
    // The detach's old claim is gone; the residual is the same under both mechanisms.
    expect(doc).not.toMatch(/only the detach stops web traffic|does not honour maintenance/);
    expect(step3).toMatch(/\*\*Residual: a tab loaded before the maintenance build went live \(owner-accepted, 2026-11-21\)\.\*\*/);
    expect(step3).toMatch(/\*\*The detach had the same residual\.\*\*/);
    expect(step3).toMatch(/reset links and\s+shared links opened on web land on the maintenance screen/);
    // The bundle check reads the flag the served bundle carries; its pattern matches the measured
    // forms (ON, and both OFF forms) and not an unrelated getEnv entry.
    const check = /MAINTENANCE_MODE:\(\)=>[A-Za-z_$][A-Za-z0-9_$]*\(("([^"\\]|\\.)*"|void 0)\)/;
    expect(step3).toContain(String.raw`grep -oE 'MAINTENANCE_MODE:\(\)=>[A-Za-z_$][A-Za-z0-9_$]*\(("([^"\\]|\\.)*"|void 0)\)'`);
    // Measured forms (#421): local builds (E), production with the flag off (t), and a quoted value,
    // which the check must SHOW (it is OFF), not swallow into no output.
    const measured: Array<[string, string]> = [
      ['RE:()=>!1,MAINTENANCE_MODE:()=>E("true")}', 'MAINTENANCE_MODE:()=>E("true")'],
      ['MAINTENANCE_MODE:()=>E(void 0)}', 'MAINTENANCE_MODE:()=>E(void 0)'],
      ['MAINTENANCE_MODE:()=>E("")}', 'MAINTENANCE_MODE:()=>E("")'],
      ['MAINTENANCE_MODE:()=>t("")}', 'MAINTENANCE_MODE:()=>t("")'],
      ['>!1,MAINTENANCE_MODE:()=>E("\\"true\\"")}', 'MAINTENANCE_MODE:()=>E("\\"true\\"")'],
    ];
    for (const [bundle, printed] of measured) {
      expect(bundle.match(check)?.[0], bundle).toBe(printed);
    }
    expect(check.test("const O=(0,S.default)('MAINTENANCE_MODE')")).toBe(false);
    // ON and OFF are predicates that print a fixed token; neither printing means stop.
    expect(step3).toMatch(/\*\*Neither printing means stop\*\*/);
    expect(step3).toContain('production, flag off, measured by main on 2026-11-21, showed `t("")`');
    // The variable's name and value (an operator set EXPO_PUBLIC_MAINTENANCE_MODE, quoted, 2026-11-21).
    for (const rel of [RUNBOOK, GUIDE, ROLLBACK, 'RELEASE.md']) {
      expect(read(rel), rel).toMatch(/EXPO_PUBLIC_MAINTENANCE_MODE`\s+(?:set\s+)?on the\s+service has \*\*no effect\*\*|EXPO_PUBLIC_MAINTENANCE_MODE`\s+(?:set\s+)?on the\s+service has no effect/);
    }
    expect(read('legacy/frontend-web/Dockerfile')).not.toMatch(/ARG EXPO_PUBLIC_MAINTENANCE_MODE/);
    expect((steps[0] as string)).toContain('**No `EXPO_PUBLIC_MAINTENANCE_MODE` variable is\n    left on the service**');
    expect(step3).toMatch(/\*\*production:\*\* `MAINTENANCE_MODE=false` on the\s+legacy web service too/);
    // The switch the runbook relies on exists in the tree.
    expect(read('legacy/frontend-web/Dockerfile')).toMatch(/ENV EXPO_PUBLIC_MAINTENANCE_MODE=\$MAINTENANCE_MODE/);
    expect(read('legacy/frontend-web/src/app/_layout.tsx')).toMatch(/if \(maintenanceMode\) \{\s*return fontsLoaded \? <MaintenanceScreen \/>/);
    // Step 1: the switch is ready, service-scoped, and the api origin is confirmed.
    const step1 = steps[0] as string;
    expect(step1).toContain('**Production: legacy web\'s maintenance switch is ready**');
    expect(step1).toContain('legacy/frontend-web/src/components/MaintenanceScreen.tsx && echo web-has-switch');
    expect(step1).toMatch(/\*\*Its `EXPO_PUBLIC_API_V2_URL` is an absolute api origin\*\*/);
  });

  it('the web flag ON and OFF checks discriminate every measured form, run as written in bash (#421 review)', () => {
    const step3 = steps[stepOf(/Maintenance mode on, web off/) - 1] as string;
    const block = step3.match(/```bash\n(web_flag\(\) \{[\s\S]*?)```/)?.[1];
    expect(block, 'the web_flag functions are in step 3').toBeDefined();
    // A stub curl stands in for the web domain: "/" serves an index naming one bundle, which holds BUNDLE.
    const run = (bundle: string, fn: 'web_flag_on' | 'web_flag_off') =>
      spawnSync('bash', ['-c', `curl() { case "$2" in */) echo '<script src="/_expo/static/js/web/entry-0a1b.js">' ;; *) printf '%s' "$BUNDLE" ;; esac; }\n${block}\n${fn} https://web.example`], {
        env: { PATH: process.env.PATH ?? '', BUNDLE: bundle },
        encoding: 'utf8',
      });
    const forms: Array<[string, 'on' | 'off' | 'neither']> = [
      ['a,MAINTENANCE_MODE:()=>E("true")}', 'on'],
      ['a,MAINTENANCE_MODE:()=>E("True")}', 'on'],
      ['a,MAINTENANCE_MODE:()=>t("1")}', 'on'],
      ['a,MAINTENANCE_MODE:()=>E(void 0)}', 'neither'], // not built through the Dockerfile: the flag does nothing (#421 1b)
      ['a,MAINTENANCE_MODE:()=>E("")}', 'off'],
      ['a,MAINTENANCE_MODE:()=>t("")}', 'off'], // production, flag off (main, 2026-11-21)
      ['a,MAINTENANCE_MODE:()=>E("false")}', 'off'],
      ['a,MAINTENANCE_MODE:()=>E("\\"true\\"")}', 'neither'], // a quoted value: OFF in the app, passes neither
      ['a,MAINTENANCE_MODE:()=>E("TRUE")}', 'neither'],
      ['a,MAINTENANCE_MODE:()=>E("true"),b,MAINTENANCE_MODE:()=>E("")}', 'neither'], // two lines
      ["const O=(0,S.default)('MAINTENANCE_MODE')", 'neither'], // no flag line
    ];
    for (const [bundle, want] of forms) {
      const on = run(bundle, 'web_flag_on');
      const off = run(bundle, 'web_flag_off');
      expect([on.status === 0, on.stdout.trim()], `ON check on ${bundle}`).toEqual(want === 'on' ? [true, 'web-flag-ON'] : [false, '']);
      expect([off.status === 0, off.stdout.trim()], `OFF check on ${bundle}`).toEqual(want === 'off' ? [true, 'web-flag-OFF'] : [false, '']);
    }
    // Each step names the check it expects.
    const step = (re: RegExp) => steps[stepOf(re) - 1] as string;
    expect(step3).toMatch(/\*\*Production:\*\* the ON check\s+\(`web_flag_on https:\/\/<web domain>`\) prints `web-flag-ON`/);
    expect(step3).toMatch(/wait until the OFF check prints `web-flag-OFF`/);
    expect(steps[0]).toMatch(/Step 3's \*\*OFF check\*\*, run now on the\s+public web domain, prints `web-flag-OFF`/);
    expect(step(/The deploys: `auth` and `backend`/)).toMatch(/run step 3's ON check after it, which must print `web-flag-ON`/);
    expect(step(/\d+\. Web back$/)).toMatch(/step 3's OFF check prints `web-flag-OFF`/);
    const rollback = read(ROLLBACK);
    expect(rollback.slice(rollback.indexOf('## 1.'), rollback.indexOf('## 2.'))).toMatch(/prints `web-flag-ON`/);
    expect(rollback.slice(rollback.indexOf('## 3.'), rollback.indexOf('## 4.'))).toMatch(/ON check prints `web-flag-ON`/);
    const rb4 = rollback.slice(rollback.indexOf('## 4.'), rollback.indexOf('## 5.'));
    expect(rb4).toMatch(/OFF check prints `web-flag-OFF`/);
    for (const option of ['**(a)**', '**(b)**', '**(c)**']) expect(rb4, option).toContain(option);
    expect(rb4).toMatch(/The failure mode of all three is web staying on the maintenance build, which is safe/);
    // Round 1b: the order in step 3 and guide step 2 (probe and ON check, THEN cutover_at).
    const order = (text: string) => [text.indexOf('web_flag_on https://<web domain>                   # production: web-flag-ON'), text.indexOf('export CUTOVER_AT=')];
    for (const text of [step3, read(GUIDE)]) {
      const [on, at] = order(text);
      expect(on, 'the ON check is in the block').toBeGreaterThan(0);
      expect(on).toBeLessThan(at);
    }
    expect(step3).toMatch(/\*\*Empty output is\s+inconclusive, never OFF\.\*\*/);
    expect(step3).toContain('curl -fsSL "$1/"');
    expect(step3).toMatch(/\*\*`\(void 0\)` passes neither, on purpose\.\*\*/);
    expect(steps[0]).toMatch(/`\(void 0\)` there means the deployed image was not built through the\s+Dockerfile's `ARG`-to-`ENV` mapping/);
    // The detach is the fallback only, in step 3, step 13's abort and rollback step 1.
    expect(step3).toMatch(/\*\*Fallback only, if the maintenance build cannot be produced \(production\):\*\*/);
    expect(step(/\d+\. Web back$/)).toMatch(/\*\*Fallback only\*\*, if that rebuild fails or hangs/);
    expect(rollback.slice(rollback.indexOf('## 1.'), rollback.indexOf('## 2.'))).toMatch(/\*\*Fallback only \(production\)\*\*/);
    expect(rollback.slice(rollback.indexOf('## 1.'), rollback.indexOf('## 2.'))).toMatch(/wait and re-run it, that is not a failure/);
    // web-sources-match: a step 1 precondition and step 13's check (not a bare commit comparison).
    expect(steps[0]).toContain('git diff --quiet <recorded web commit> origin/<web deploy branch> -- legacy/frontend-web && echo web-sources-match');
    expect(step(/\d+\. Web back$/)).toContain('git diff --quiet <recorded web commit> <deployed web commit> -- legacy/frontend-web && echo web-sources-match');
    expect(step(/\d+\. Web back$/)).not.toMatch(/serving \(`RELEASE\.md`\)|or\s+step 10's if the push rebuilt it/);
    expect(step3).toMatch(/step 6 copies them, and a rollback keeps them/);
    expect(step3).toMatch(/each add a build to the window, and a rollback's steps 1 and 4 two more/);
    expect(step3).toMatch(/The Caddyfile's `no-cache` is the origin's header/);
    // Production returns only backend; the web's recorded ID is kept, not redeployed in step 3.
    expect(rollback).toMatch(/\*\*In production only `backend` returns:\*\*/);
    expect(doc).toMatch(/In production, rollback step 3 returns only `backend` to its\s+recorded deployment/);
    expect(read(GUIDE)).toMatch(/In production, the rollback returns only `backend` to its\s+recorded deployment/);
    for (const rel of [RUNBOOK, ROLLBACK, GUIDE]) {
      expect(read(rel), rel).not.toMatch(/returns? only `backend` and(?:\s+the)?\s+web(?:\s+service)?|return `backend` and the web service to the deployments/);
    }
  });

  it('step 13 turns legacy web\'s flag off in production, with a failed-rebuild case; 12a is skipped in production (owner, 2026-11-21)', () => {
    const step13 = steps[stepOf(/^\d+\. Web back$/) - 1] as string;
    expect(step13).toMatch(/\*\*Production: `MAINTENANCE_MODE=false` on the legacy web service\*\*/);
    expect(step13).toMatch(/\*\*Staging:\*\* re-attach the web domain/);
    expect(step13).toMatch(/\*\*If the rebuild fails or hangs \(production\):\*\*/);
    expect(step13).toMatch(/\*\*Abort\*\*[\s\S]*production: `MAINTENANCE_MODE=true` on the legacy web service/);
    const step12a = doc.slice(doc.indexOf('## 12a.'), doc.indexOf('## 13.'));
    expect(step12a).toContain('### Production: skipped (owner\'s decision, 2026-11-21)');
    expect(step12a).toMatch(/first exercised at steps 13 and 14, alongside real users/);
    expect(step12a).toContain('### An environment that serves legacy web and takes it offline by a detach: unchanged');
    expect(step12a).toContain('**Staging skips 12a:** it has no legacy web service');
    // Web's flag goes off at 13, backend's at 15; step 15 says it does not touch web.
    expect(stepOf(/^\d+\. Web back$/)).toBeLessThan(stepOf(/Maintenance mode off/));
    expect(steps[stepOf(/Maintenance mode off/) - 1]).toMatch(/its own flag went off at step 13/);
    // The rollback, the guide, the record and RELEASE.md say the same.
    const rollback = read(ROLLBACK);
    expect(rollback).toMatch(/\*\*Production:\*\* `MAINTENANCE_MODE=true` on the legacy web service/);
    expect(rollback).toMatch(/\*\*Production: do not redeploy the recorded ID\.\*\*/);
    expect(rollback).toMatch(/\*\*Production:\*\* `MAINTENANCE_MODE=false` on the legacy web service/);
    const guide = read(GUIDE);
    expect(guide).toMatch(/\*\*Production:\*\* set `MAINTENANCE_MODE=true` on the \*\*legacy web service\*\*/);
    expect(guide).toMatch(/\*\*Production:\*\* set `MAINTENANCE_MODE=false` on the legacy web\s+service/);
    expect(read(RECORD)).toContain('## 2026-11-21: owner decision: legacy web goes offline by its maintenance flag');
    expect(read('RELEASE.md')).toMatch(/It also takes `MAINTENANCE_MODE` \(PR #418\)/);
    // No operator doc still detaches the production web domain.
    for (const rel of [RUNBOOK, ROLLBACK, GUIDE]) {
      expect(read(rel), rel).not.toMatch(/detach the web domain from the web service \(production|Detach the web domain from the web service \(the legacy web service in production/);
    }
  });

  // A service-key command as an operator would run it: tsx invoking the script's create-service /
  // create-key subcommand. A prose mention of the script (release-record.md) is not a command.
  const KEY_COMMAND = /tsx\s+\S*service-keys\.ts\s+create-(?:service|key)\b/;
  // The superseded instruction to issue the keys between the copy and the promotion (2026-11-21).
  const KEYS_BEFORE_PROMOTION = /issued after the copy\s+and before step 10's promotion/;
  const unstruck = (text: string) => text.replace(/~~[^~]*~~/g, '');
  // Every docs/cutover page an operator reads during the window. service-keys-runbook.md is the
  // keys' own runbook, used after the window, and legitimately holds the commands.
  const OPERATOR_DOCS = readdirSync(resolve(repoRoot, 'docs/cutover'))
    .filter((f) => f.endsWith('.md') && f !== 'service-keys-runbook.md')
    .map((f) => `docs/cutover/${f}`);

  it('the key scans match planted lines and ignore their near-misses', () => {
    expect(KEY_COMMAND.test('./node_modules/.bin/tsx scripts/service-keys.ts create-service ansari-mcp')).toBe(true);
    expect(KEY_COMMAND.test('./node_modules/.bin/tsx scripts/service-keys.ts create-key ansari-mcp --rate-max 1')).toBe(true);
    expect(KEY_COMMAND.test('`apps/auth/scripts/service-keys.ts create-service` (through `createServiceUser`)')).toBe(false);
    expect(KEY_COMMAND.test('There is no `create-service`\nand no `create-key` anywhere in the window.')).toBe(false);
    const planted = 'The keys are issued after the copy\n  and before step 10\'s promotion.';
    expect(KEYS_BEFORE_PROMOTION.test(unstruck(planted))).toBe(true);
    expect(KEYS_BEFORE_PROMOTION.test(unstruck(`~~${planted}~~ [superseded]`))).toBe(false);
  });

  it('issues no service keys in the window: no key command, and no unstruck key issuance before the promotion, in any operator doc (owner, 2026-11-21)', () => {
    expect(OPERATOR_DOCS).toContain(RECORD);
    expect(OPERATOR_DOCS.length).toBeGreaterThanOrEqual(6);
    const commands = OPERATOR_DOCS.flatMap((rel) => read(rel).split('\n').filter((l) => KEY_COMMAND.test(l)).map((l) => `${rel}: ${l}`));
    const issuance = OPERATOR_DOCS.filter((rel) => KEYS_BEFORE_PROMOTION.test(unstruck(read(rel))));
    console.info(`[cutover-docs] key commands: ${commands.length}; unstruck pre-promotion issuance: ${issuance.length} (in ${OPERATOR_DOCS.length} docs)`);
    expect(commands).toEqual([]);
    expect(issuance).toEqual([]);
    // The struck line is still there, as history.
    expect(read(RECORD)).toMatch(/~~[^~]*issued after the copy\s+and before step 10's promotion[^~]*~~\s*\[Superseded 2026-11-21/);
    expect(doc).toContain('**No service keys in this window**');
    expect(read(GUIDE)).toContain('**No service keys in the window**');
  });

  it('the rehearsal precondition is waived for production, with its consequence stated, everywhere it was a precondition (owner, 2026-11-21)', () => {
    const step1 = steps[0] as string;
    const bullet = step1.slice(step1.indexOf('- **Production only:'), step1.indexOf('- **The operator machine'));
    expect(bullet).toContain('**Production only: the rehearsal precondition is waived for this window** (owner, 2026-11-21)');
    expect(bullet).toMatch(/edge properties are first measured live at steps 11 and 12/);
    expect(bullet).toMatch(/step 12a is not available in production: steps 13 and 14 are the first time/);
    expect(bullet).toContain('On the staging run itself, this item reads:');
    expect(read(GUIDE)).toMatch(/rehearsal precondition is \*\*waived for this window\*\*/);
    expect(read(GUIDE)).not.toMatch(/the staging rehearsal has passed and its evidence is merged/);
    expect(read(RECORD)).toMatch(/\*\*The rehearsal precondition is waived for this window\*\*/);
    expect(read('docs/cutover/rehearsal.md')).toMatch(/The owner waives, for this production window/);
  });

  it('MCP_COMPLETE_KEY_MODE=log-only is a hard precondition (no key is issued in the window)', () => {
    const step1 = steps[0] as string;
    expect(step1).toContain('**`MCP_COMPLETE_KEY_MODE=log-only` on `backend` is confirmed before the window**');
    expect(step1).toContain('**If the variable is absent, or `enforce`, do not start.**');
  });

  it('production branches: auth is already deployed and attached; step 9 skips the attach and expects 200 (owner, 2026-11-21)', () => {
    const step1 = steps[0] as string;
    expect(step1).toMatch(/`auth` \*\*has\*\* a live deployment and `auth\.askansari\.ai` \*\*is attached\*\*/);
    const step9 = steps[stepOf(/Attach `auth\.askansari\.ai`/) - 1] as string;
    const prodAt = step9.indexOf('### Production: skip the attach');
    const stagingAt = step9.indexOf('### Staging');
    expect(prodAt).toBeGreaterThanOrEqual(0);
    expect(stagingAt).toBeGreaterThan(prodAt);
    const prod = step9.slice(prodAt, stagingAt);
    expect(prod).toMatch(/\*\*Check \(production\):\*\*[\s\S]*prints `200`/);
    expect(prod).toMatch(/\*\*Abort \(production\):\*\* do \*\*not\*\* detach the domain or remove the deployment/);
    expect(prod).toContain('[Empty the production auth database: drop and re-apply]');
    expect(prod).not.toMatch(/`404` or `502`/);
    const guide = read(GUIDE);
    expect(guide).toMatch(/\$AUTH\/health\s+# PRODUCTION: 200; never 000/);
    expect(guide).toMatch(/\$AUTH\/health\s+# STAGING: 404 or 502; never 200, never 000/);
  });

  it('production auth: source main after the 2026-11-21 window, what deployed it open; step 9 checks its tree, step 11 waits for or hand-deploys the promoted commit, step 16 confirms the source (#416 close-out)', () => {
    const tree = 'git diff --quiet <auth running commit> HEAD -- apps/auth packages package.json pnpm-lock.yaml pnpm-workspace.yaml && echo auth-tree-matches';
    const step1 = steps[0] as string;
    expect(step1).toMatch(/\*\*Production `auth`'s\s+source branch is `main` after the 2026-11-21 window\*\* \(owner's statement\)/);
    // The cause is open (security, 12:27Z): no doc states that the push deployed auth or that Railway waits for CI.
    expect(step1).toMatch(/\*\*Not established:\*\* whether that deployment was started by the push or\s+by a dashboard action/);
    for (const rel of [RUNBOOK, ROLLBACK, GUIDE, RECORD, 'docs/cutover/edge-check.md']) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/push (?:to `main` )?deploys production\s+`auth`|push deploys \*\*`auth` too|push(?: already)? deployed (?:it|`auth`)|push redeployed `auth`|`auth` deploys from `main`/);
      expect(text, rel).not.toMatch(/nothing deploys until CI on `main` is green|Railway waits for the CI run|once CI on `main` is green/);
    }
    // The history stays honest: the earlier statement is named as the owner's, before the window.
    expect(step1).toMatch(/Before the window the\s+owner's statement was that it deploys\s+from `develop`/);
    // The old claims are gone as live statements, everywhere (the struck-through history excepted).
    for (const rel of [RUNBOOK, ROLLBACK, GUIDE, 'docs/cutover/edge-check.md']) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/\*\*step 10's push to `main`\s+starts no `auth` deployment\*\*/);
      expect(text, rel).not.toMatch(/starts \*\*no\*\* `auth` deployment|Wait for `backend` only/);
      expect(text, rel).not.toMatch(/\(it\s+deploys\s+from\s+`develop`|`auth`\s+deploys\s+from\s+`develop`(?!`)/);
      expect(text, rel).not.toMatch(/`auth` is untouched/);
    }
    const step9 = steps[stepOf(/Attach `auth\.askansari\.ai`/) - 1] as string;
    expect(step9).toContain(tree);
    expect(step9).toMatch(/stop\s+here, before step 10/);
    expect(read(GUIDE)).toContain(tree);
    // The tree check's paths are auth's build inputs: every watch pattern of its railway.toml.
    const toml = read('apps/auth/railway.toml');
    for (const path of ['apps/auth', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      expect(toml, path).toContain(`"${path}`);
    }
    const step10 = steps[stepOf(/Promote `develop` to `main`/) - 1] as string;
    // The measured timeline, causes open; B4: the admin push's bypass notice is not a rejection.
    expect(step10).toMatch(/\*\*What happened after the push on 2026-11-21 \(measured; the causes are open\)\.\*\*/);
    expect(step10).toMatch(/\*\*Not established:\*\* whether Railway waits for CI on `main`, and whether the push started any\s+deployment at all/);
    expect(step10).toContain('remote: Bypassed rule violations');
    expect(step10).toMatch(/\*\*not a rejection\*\*/);
    const step11 = steps[stepOf(/The deploys: `auth` and `backend`/) - 1] as string;
    expect(step11).toMatch(/Wait for the deployments of step 10's commit on `backend` and on `auth`/);
    expect(step11).toMatch(/\*\*Production: `auth`\.\*\* Wait for a deployment of step 10's commit on `auth`\. If none appears/);
    expect(step11).toMatch(/deploy the latest commit of `main` on `auth` by hand,\s+and confirm the deployment's commit is step 10's/);
    // B3: backend did not auto-deploy on 2026-11-21; the manual deploy, its commit check, the cause open.
    expect(step11).toMatch(/\*\*Production: if no `backend` deployment appears\.\*\*/);
    expect(step11).toMatch(/deploy the latest\s+commit of `main` on `backend` by hand, and confirm the deployment's commit is\s+step 10's/);
    expect(step11).toMatch(/cause is \*\*not established\*\*/);
    const step16 = doc.slice(doc.indexOf('## 16.'), doc.indexOf('## Orphan app rows'));
    expect(step16).toMatch(/\*\*First, production: confirm `auth`'s source branch is `main`, and record its deployment\*\*/);
    expect(step16.indexOf("confirm `auth`'s source branch")).toBeLessThan(step16.indexOf('un-silence the alerts'));
    expect(step16).toMatch(/No new deployment is triggered here/);
    expect(step16).not.toMatch(/Set the `auth` service's source branch to `main`/);
    // Round 4: main must be the promoted commit; the check is against the recorded commit; three states.
    const promoted = 'git fetch origin && [ "$(git rev-parse origin/main)" = "<recorded commit>" ] && echo main-is-promoted-commit';
    expect(step16).toContain(promoted);
    expect(read(GUIDE)).toContain(promoted);
    expect(step16).toMatch(/deployed commit equals `<recorded commit>`/);
    expect(step16).not.toMatch(/equals `git rev-parse origin\/main`/);
    for (const state of ["**(a) Before the promoted commit's deployment:**", "**(b) Promoted commit's deployment Active:**", "**(c) Promoted commit's build failed:**"]) {
      expect(step16, state).toContain(state);
    }
    expect(step16).toMatch(/This is the state from step 11 on/);
    // A second attempt overrides step 1's auth line; step 1 points there.
    expect(step1).toMatch(/This line describes the \*\*first attempt\*\*/);
    const second = read(ROLLBACK).slice(read(ROLLBACK).indexOf('## A second attempt'), read(ROLLBACK).indexOf('## If no second attempt'));
    expect(second).toMatch(/\*\*Production overrides/);
    expect(second).toMatch(/only on the security architect's word/);
    // The guide maps its step numbers to the runbook's.
    const mapping = [...read(GUIDE).matchAll(/^\| (\d+)\. ([^|]+) \| ([^|]+) \|$/gm)].map((m) => Number(m[1]));
    expect(mapping).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(read(GUIDE)).toMatch(/\| 7\. Attach the auth domain \| 9 \|/);
  });

  it('runs from a fresh checkout verified against the recorded commit, never the spir-300 worktree (#416)', () => {
    expect(doc).toContain('[ "$(git rev-parse HEAD)" = "<recorded commit>" ] && echo checkout-at-recorded-commit');
    expect(doc).toContain('ls apps/auth/scripts/cutover/auth-journal.mjs packages/auth/drizzle/0001_api_key.sql');
    // Clean, fresh clone (#416 round 2): the clean-tree line in both docs, in the opening block and
    // again before the first repo script (runbook step 5, guide step 3).
    const clean = '[ -z "$(git status --porcelain)" ] && echo clean-tree';
    const guide = read(GUIDE);
    const between = (text: string, from: string, to: string) => {
      const a = text.indexOf(from);
      const b = text.indexOf(to, a + 1);
      expect(a, from).toBeGreaterThanOrEqual(0);
      expect(b, to).toBeGreaterThan(a);
      return text.slice(a, b);
    };
    for (const [name, opening, script] of [
      ['runbook', between(doc, '**The operator environment', '**A dry run before the window'), between(doc, '## 5. The auth baseline', '## 6. ')],
      ['guide', between(guide, '## 1. Open the operator session', '## 2. '), between(guide, '## 3. Auth schema', '## 4. ')],
    ] as const) {
      expect(opening, `${name}: clean-tree in the opening block`).toContain(clean);
      expect(opening, name).toMatch(/git clone <repo URL> <new empty directory>/);
      expect(script, `${name}: clean-tree before the first script`).toContain(clean);
    }
    expect(doc).not.toMatch(/\*\*The checkout is the `builder-spir-300` worktree\*\*/);
    expect(read(GUIDE)).not.toMatch(/# the builder-spir-300 worktree/);
    for (const text of [doc, read(GUIDE)]) expect(text).not.toMatch(/builder-spir-300|6ed22431/);
    // #416 round 3: nothing deploys production auth in the window.
    for (const text of [doc, read(GUIDE)]) {
      expect(text).not.toMatch(/stays on\s+step 10's deployment|stays on the deployment serving after the deploys/);
    }
  });

  it('step 1 gives auth\'s state per environment: production deployed and attached, staging none; admins are granted by id (H-7)', () => {
    const step1 = steps[0] as string;
    const prod = step1.indexOf('**Production (owner\'s decision, 2026-11-21;');
    const staging = step1.indexOf('**Staging, and any environment without that decision:** **no domain yet** and **no active deployment**');
    expect(prod).toBeGreaterThanOrEqual(0);
    expect(staging).toBeGreaterThan(prod);
    // The both-environments requirements are their own top-level bullet, not inside the staging one.
    expect(step1).toMatch(/^- \*\*In both environments, the variables:\*\*/m);
    const admins = steps[stepOf(/Admin roles/) - 1] as string;
    expect(admins).toContain('grant-admin.ts <email> --confirm <id>');
    expect(admins).toContain('05-audit-admins-auth.sql');
    expect(admins).toMatch(/no `ADMIN_EMAILS` to set and no `auth` redeploy/);
    expect(admins).not.toMatch(/set `ADMIN_EMAILS`/);
  });

  it("names the operator environment: the owner's machine through the Tailscale forwarder (H-8)", () => {
    expect(doc).toContain('**The operator environment (spec H-8).**');
    // The scripts do not check the checkout (owner, 2026-10-19): no PROMOTED_COMMIT gate in them.
    // The operator's own clean-tree line (#416) is tested with the fresh checkout. The owner
    // confirmed it on 2026-11-21 as a narrowing of the 2026-10-19 "no clean-checkout gate"
    // decision: the operator runs the line, and the scripts still check nothing.
    expect(doc).not.toMatch(/PROMOTED_COMMIT/);
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

  it.each([/Edge probe on the `apps\/api` production domains/, /The deploys: `auth` and `backend`/])(
    '%s checks both edge properties on both paths: two headers forged via Cloudflare, all three direct, and two networks differ',
    (title) => {
      const step = steps[stepOf(title) - 1] as string;
      const lines = step.split('\n').filter((l) => l.startsWith('curl -4 -s -H'));
      // Direct (--resolve): all three forged.
      const direct = lines.filter((l) => l.includes('--resolve'));
      expect(direct.length).toBeGreaterThan(0);
      for (const l of direct) {
        expect(l).toMatch(/-H 'X-Real-IP: 192\.0\.2\.66' -H 'X-Forwarded-For: 192\.0\.2\.66' -H 'CF-Connecting-IP: 192\.0\.2\.66'/);
      }
      // Via Cloudflare: never CF-Connecting-IP (Cloudflare answers 403, error code: 1000; measured 2026-11-21).
      const viaCf = lines.filter((l) => !l.includes('--resolve'));
      expect(viaCf.length).toBeGreaterThan(0);
      for (const l of viaCf) {
        expect(l).toMatch(/-H 'X-Real-IP: 192\.0\.2\.66' -H 'X-Forwarded-For: 192\.0\.2\.66' https:/);
        expect(l).not.toMatch(/CF-Connecting-IP/);
      }
      expect(step).toMatch(/second network/);
      expect(step).toMatch(/--resolve/);
    }
  );

  it('edge-check.md: the via-Cloudflare method forges no CF-Connecting-IP; the window rows are filled (#416 close-out)', () => {
    const edge = read('docs/cutover/edge-check.md');
    expect(edge).toContain("FORGED_CF=(-H 'X-Real-IP: 192.0.2.66' -H 'X-Forwarded-For: 192.0.2.66')");
    expect(edge).toContain('curl -4 -s "${FORGED_CF[@]}" "$URL"');
    expect(edge).toContain('curl -6 -s "${FORGED_CF[@]}" "$URL"');
    expect(edge).toMatch(/`403` with the body `error code: 1000`/);
    for (const row of [
      '| `api.askansari.ai` via Cloudflare | window step 12 | **PASS** |',
      '| `api.askansari.ai` direct to the Railway edge | window step 12 | **PASS** |',
      '| `api-35.ansari.chat` direct | window step 12 | **PASS** |',
      '| `auth.askansari.ai` via Cloudflare | window step 11 | **PASS** |',
      '| `auth.askansari.ai` direct to the Railway edge | window step 11 | not measured:',
    ]) {
      expect(edge, row).toContain(row);
    }
    expect(edge).toMatch(/\*\*Production verdict \(window step 12, 2026-11-21\):\*\*/);
    // Real addresses never appear: every window row uses the RFC 5737 scheme.
    const realIp = /(?<!\w)x_real_ip: (?!203\.0\.113\.|192\.0\.2\.)/;
    expect(edge).not.toMatch(realIp);
    // The scan can fail: a real-looking address is caught, a field ending in x_real_ip is not.
    expect('`{x_real_ip: 8.8.8.8, ...}`').toMatch(realIp);
    expect('x_forwarded_for_first_is_x_real_ip: false').not.toMatch(realIp);
  });

  it('records that legacy clients sign up under maintenance, and recommends the dry run at step 6 (measured 2026-11-21)', () => {
    const step3 = steps[stepOf(/Maintenance mode on, web off/) - 1] as string;
    expect(step3).toMatch(/\*\*Measured on 2026-11-21: legacy clients keep registering under maintenance\.\*\*/);
    expect(step3).toMatch(/87,825 to 87,829/);
    expect(step3).toMatch(/\*\*any sign-up between the copy and the new\s+`apps\/api` going live \(step 11\) is an orphan app row\*\*/);
    const step6 = steps[stepOf(/The copy and the audits/) - 1] as string;
    expect(step6).toMatch(/\*\*Recommended: the dry run first, in the same session\.\*\*/);
    expect(step6).toContain('apps/auth/scripts/cutover/copy.sh --dry-run');
    // The procedure is otherwise unchanged: the copy line is still the bare script.
    expect(step6).toMatch(/^apps\/auth\/scripts\/cutover\/copy\.sh$/m);
  });

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

  it('production rollback: auth is untouched, domain attached, auto-deploy off; staging as before (owner, 2026-11-21)', () => {
    const step3 = doc.slice(doc.indexOf('## 3. Auto-deploy off'), doc.indexOf('## 4.'));
    expect(step3).toMatch(/\*\*Production: `auth` stays where it is\.\*\*/);
    expect(step3).toMatch(/\*\*Check \(production\):\*\*[\s\S]*`200`[\s\S]*auto-deploy\s+shows off/);
    // Window step 16's three states, each with its own check (#416 round 4).
    const check = step3.slice(step3.indexOf('**Check (production):**'), step3.indexOf('**Check (staging):**'));
    expect(check).toMatch(/\*\*\(a\) or \(c\):\*\*[\s\S]*auth-tree-matches/);
    expect(check).toMatch(/\*\*\(b\):\*\*[\s\S]*window step 16 recorded/);
    for (const state of ["(a) Before the promoted commit's deployment", "(b) Promoted commit's deployment Active", "(c) Promoted commit's build failed"]) {
      expect(step3, state).toContain(state);
    }
    expect(step3).toMatch(/from window step 11 on; the 2026-11-21\s+window/);
    expect(step3).toMatch(/\*\*Check \(staging\):\*\*[\s\S]*`auth` has no active deployment/);
    expect(step3.indexOf('**Check (production):**')).toBeLessThan(step3.indexOf('**Check (staging):**'));
    const step5 = doc.slice(doc.indexOf('## 5. Detach'), doc.indexOf('## 6.'));
    expect(step5).toMatch(/^\*\*Production: skip this step\.\*\*/m);
    expect(step5.indexOf('**Production: skip this step.**')).toBeLessThan(step5.indexOf('**Staging'));
    expect(step5).toContain('https://auth-staging.askansari.ai/health');
    expect(doc).toMatch(/\*\*Production `auth` is not a rollback target\*\*/);
    expect(doc).not.toMatch(/not decided|OPEN OWNER DECISION|window's deployment\*\* \(step 10's commit\)/i);
  });

  it('empties the auth database: production by the named drop-and-re-apply procedure, staging by the drop alone (R6; owner, 2026-11-21)', () => {
    const PROC = '[Empty the production auth database: drop and re-apply]';
    const runbook = read(RUNBOOK);
    const proc = runbook.slice(runbook.indexOf('## Empty the production auth database: drop and re-apply'), runbook.indexOf('## 1. Preconditions'));
    // ONE transaction: the drop and every journal file, in order, piped into a single psql.
    // The journal list is captured first and must be non-empty: an empty list would make `cat` read
    // the terminal, and the drop could commit without the journal.
    // The journal check runs inside the same transaction, so a missing object rolls the drop back.
    const oneTxn = `F="$(node apps/auth/scripts/cutover/auth-journal.mjs files)" && C="$(node apps/auth/scripts/cutover/auth-journal.mjs check)" && [ -n "$F" ] && [ -n "$C" ] && { echo "set lock_timeout = '5s';"; echo 'DROP SCHEMA auth CASCADE;'; cat $(printf '%s\\n' "$F"); printf '%s\\n' "$C"; } | psql "$AUTH_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction`;
    expect(proc).toContain(oneTxn);
    expect(proc).not.toMatch(/^psql .*-c 'DROP SCHEMA/m);
    expect(proc).toContain('git diff --quiet <auth running commit> HEAD -- packages/auth/drizzle && echo journal-matches');
    expect(proc).toContain("curl -s -o /dev/null -w '%{http_code}' https://auth.askansari.ai/api/auth/jwks");
    expect(proc).toMatch(/\*\*Check:\*\*[\s\S]*`<tag>\|t`[\s\S]*prints `0`[\s\S]*JWKS probe prints `200`\. Not\s+`\/health`/);
    expect(proc).toMatch(/\*\*stays true\*\*/);
    // Every DROP SCHEMA line in the runbook, the guide and the rollback is inside the procedure,
    // under a `### Staging` heading, or on a line labelled staging (#416 round 3).
    // The procedure is exempt by its LINE RANGE (its heading to the next `## `), never by matching
    // text, so a production drop copied verbatim elsewhere is still caught (#416 round 4).
    const bare = (text: string) => {
      const lines = text.split('\n');
      const start = lines.findIndex((l) => l === '## Empty the production auth database: drop and re-apply');
      const end = start < 0 ? -1 : lines.findIndex((l, k) => k > start && l.startsWith('## '));
      return lines.flatMap((line, i) => {
        if (!/DROP SCHEMA/.test(line) || (start >= 0 && i > start && i < end) || /staging/i.test(line)) return [];
        for (let j = i; j >= 0; j--) {
          const heading = /^#{2,3} (.*)$/.exec(lines[j] ?? '');
          if (heading) return /^Staging/.test(heading[1] ?? '') ? [] : [line];
        }
        return [line];
      });
    };
    expect(bare('## 9. X\n**Abort (production):** `DROP SCHEMA auth CASCADE`')).toHaveLength(1);
    expect(bare('### Staging, and so on\nrun `DROP SCHEMA auth CASCADE`')).toHaveLength(0);
    expect(bare('## 5. X\n**Abort (staging):** `DROP SCHEMA auth CASCADE`')).toHaveLength(0);
    // The exact planted case: the procedure's own drop line, copied verbatim into a later step.
    const dropLine = runbook.split('\n').find((l) => l.includes("echo 'DROP SCHEMA auth CASCADE;'")) ?? '';
    expect(dropLine).not.toBe('');
    expect(bare(runbook)).toEqual([]);
    expect(bare(runbook.replace('## 8. Admin roles', `${dropLine}\n\n## 8. Admin roles`))).toEqual([dropLine]);
    const hits = [bare(runbook), bare(read(GUIDE)), bare(doc)].flat();
    console.info(`[cutover-docs] DROP SCHEMA lines outside the procedure or a staging branch: ${hits.length}`);
    expect(hits).toEqual([]);
    const section = doc.slice(doc.indexOf('## If no second attempt follows within 7 days'));
    expect(section).toMatch(/within 7 days/);
    const prodAt = section.indexOf('### Production: drop, then re-apply');
    const stagingAt = section.indexOf('### Staging');
    expect(prodAt).toBeGreaterThanOrEqual(0);
    expect(stagingAt).toBeGreaterThan(prodAt);
    const prod = section.slice(prodAt, stagingAt);
    expect(prod).toContain(PROC);
    expect(prod).not.toMatch(/DROP SCHEMA/);
    expect(prod).toMatch(/do\s+not reverse it/);
    const staging = section.slice(stagingAt);
    expect(staging).toContain("DROP SCHEMA auth CASCADE'");
    expect(staging).not.toContain('auth-journal.mjs files');
    // The second attempt uses the procedure in production too, and step 5 is then check only.
    const second = doc.slice(doc.indexOf('## A second attempt'), doc.indexOf('## If no second attempt'));
    expect(second).toContain(PROC);
    expect(second).toMatch(/\*\*check only\*\*/);
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
    // A `|` inside a GFM table cell must be written `\|` (even in code), or it splits the cell;
    // the owner copies the rendered text, so the escape is undone before comparing.
    const rowsOf = (text: string) =>
      [...text.matchAll(/^\| `([a-z-]+)` \| `([^`]+)` \|$/gm)].map((m) => [m[1], m[2]?.replace(/\\\|/g, '|')]);
    // Two tables: the patterns to register now, and (#314) the ones for the day the
    // legacy-key window closes, both derived from the code, never typed by hand.
    const [now, closed] = scanning.split('| Service | Pattern after the window closes |');
    expect(closed, 'the closed-window table').toBeDefined();
    const names = Object.keys(serviceUsers.SERVICES) as serviceUsers.ServiceName[];
    expect(rowsOf(now ?? '')).toEqual(names.map((name) => [name, serviceUsers.SECRET_SCANNING_PATTERNS[name].source]));
    expect(rowsOf(closed ?? '')).toEqual(names.map((name) => [name, serviceUsers.scanningPatternFor(name, false).source]));
    for (const legacy of Object.values(serviceUsers.LEGACY_SCANNING_PATTERNS).flat()) expect(now).toContain(`\`${legacy.source}\``);
    expect(scanning).toContain('Settings → Code security → Secret scanning → Custom patterns');
    expect(scanning).toMatch(/\*\*revoke the key at once\*\*/);
  });
});

describe('the release record: the production window, as run (2026-11-21, #416 close-out)', () => {
  const record = read(RECORD);
  const at = record.indexOf('## 2026-11-21: the production window, as run');
  const section = record.slice(at);

  it('is the last entry, with the promoted commit and the counts', () => {
    expect(at).toBeGreaterThan(0);
    expect(section.slice(3)).not.toMatch(/^## /m);
    expect(section).toContain('`c314fa5919e797d307a8daf132217c0b10765863`');
    expect(section).toMatch(/1,484/);
    expect(section).toMatch(/\*\*87,829 users migrated\*\*/);
    expect(section).toMatch(/No journal file applied in the window/);
  });

  it('marks what only the owner can fill, and invents nothing in its place', () => {
    const owed = section.match(/\*\*owner to fill\*\*/g) ?? [];
    console.info(`[cutover-docs] release record: ${owed.length} "owner to fill" markers`);
    expect(owed.length).toBeGreaterThanOrEqual(15);
    for (const row of [
      '`cutover_at`: **owner to fill**',
      '**Rollback deadline** (`cutover_at` + 24 hours): **owner to fill**',
      'Key ids and names:\n  **owner to fill**',
    ]) {
      expect(section, row).toContain(row);
    }
  });

  it('holds no email address and no service key', () => {
    const email = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const key = /ansari_[a-z]+_(?:production|staging|development)_[A-Za-z0-9]/;
    expect(record).not.toMatch(email);
    expect(record).not.toMatch(key);
    // The scans can fail.
    expect('someone@example.com').toMatch(email);
    expect('ansari_wa_production_AbC123').toMatch(key);
    expect('`ansari_wa_production_`').not.toMatch(key);
  });
});

describe('review round 1 of PR #422: the rollback after the 2026-11-21 window', () => {
  const rollback = read(ROLLBACK);
  const record = read(RECORD);
  const runbook = read(RUNBOOK);

  it('says the rollback inputs are unfilled: the record has a rollback-critical block, the rollback says to get them first', () => {
    const asRun = record.slice(record.indexOf('## 2026-11-21: the production window, as run'));
    const block = asRun.indexOf('**Rollback-critical, needed before anything else:**');
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThan(asRun.indexOf('### Commits'));
    expect(asRun).toMatch(/\*\*Until these are filled, \[`rollback\.md`\]\(rollback\.md\) cannot be\s+> run as written\*\*/);
    const head = rollback.slice(0, rollback.indexOf('Rollback is a **redeploy'));
    expect(head).toMatch(/\*\*If the release record does not yet\s+hold `cutover_at` or the deployment IDs\*\*/);
    expect(head).toMatch(/before step 2 or step 3\. Never pick a deployment by eye\./);
  });

  it('gives the service keys a disposition, read from the code at 27531c8f', () => {
    expect(rollback).not.toMatch(/a rollback has no service user or key to deal with/);
    for (const part of ['**(a) WhatsApp is refused by the restored api.**', '**(b) MCP keeps being served, unauthenticated.**', '**(c) Emptying the production auth database deletes both keys.**']) {
      expect(rollback, part).toContain(part);
    }
    expect(rollback).toContain('legacy/whatsapp/src/ansari_whatsapp/services/auth_client_real.py');
    expect(rollback).toContain('27531c8f:apps/api/src/app/api/v2/mcp-complete/route.ts');
    // (The claims were read from 27531c8f by hand; the api CI job's checkout is shallow, so no git lookup here.)
    expect(runbook).toMatch(/\*\*Since 2026-11-21, after the window: the drop deletes the production service keys\.\*\*/);
  });

  it('handles a deployment in flight wherever the three states are listed', () => {
    const step3 = rollback.slice(rollback.indexOf('## 3. Auto-deploy off'), rollback.indexOf('## 4.'));
    const step7 = rollback.slice(rollback.indexOf('## 7.'), rollback.indexOf('## A second attempt'));
    const step16 = runbook.slice(runbook.indexOf('## 16.'), runbook.indexOf('## Orphan app rows'));
    for (const [name, text] of [['rollback step 3', step3], ['rollback step 7', step7], ['runbook step 16', step16]] as const) {
      expect(text, name).toMatch(/does not cancel it/);
      expect(text, name).toMatch(/cancel\s+it\s+in\s+the\s+dashboard,\s+then\s+classify\s+the\s+state/);
    }
  });

  it('names the second attempt\'s state, and step 11 points there', () => {
    const second = rollback.slice(rollback.indexOf('## A second attempt'), rollback.indexOf('## If no second attempt'));
    expect(second).toMatch(/\*\*The state in a second attempt is \(a\) throughout:\*\*/);
    expect(second).toMatch(/still\s+the deployment step 9 checked and that step 9's tree line still prints `auth-tree-matches`/);
    const step11 = runbook.split(/^## (?=\d+\. )/m).find((s) => s.startsWith('11. ')) as string;
    expect(step11).toMatch(/This\s+bullet describes the \*\*first attempt\*\*/);
    expect(step11).toMatch(/\*\*Production: both an automatic and a manual deployment\*\*/);
  });

  it('guards a revert of the promotion while auth deploys from main', () => {
    const guard = /\*\*No revert of the promotion is merged to `main` while production `auth`'s auto-deploy is on;\s+turn it off first\.\*\*/;
    expect(rollback.slice(rollback.indexOf('## 7.'))).toMatch(guard);
    expect(record).toMatch(guard);
    expect(rollback).toContain('`git cat-file -e 27531c8f:apps/auth/Dockerfile` fails');
  });

  it('leaves no edge-check cell blank', () => {
    const rows = read('docs/cutover/edge-check.md').split('\n').filter((l) => /^\| .* \| (phase 13|window step 1[12]) \|/.test(l));
    expect(rows.length).toBe(10);
    for (const row of rows) expect(row, row).not.toMatch(/\|\s*\|/);
  });
});


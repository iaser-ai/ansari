import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'node:test';

// The release-input gate (scripts/check-release.mjs) and the tag-based release sequence it validates.
// Everything here is a FIXTURE: a disposable repository whose lockfile and workspace file
// are synthesized in this test (candidate-shaped or registry-shaped), never read from the committed tree, so the tests pass
// before and after the committed tree switches from the private candidate to a real registry SDK. No version below exists on
// any registry, nothing is pushed or deployed, and no npm tag is touched. Whether a real SDK release is on the registry is a separate
// question, answered only by `pnpm check:release --target <env>` against the live registry.
const root = fileURLToPath(new URL('../', import.meta.url));
type Problems = {problems: string[]; packages: {name: string; version: string}[]; facts: {appVersion: string}};
type Gate = {
  validateRelease(options: {appRoot: string; target?: string}): Problems;
  verifyRegistry(packages: {name: string; version: string}[], view: (spec: string) => string): {verified: string[]; failed: string[]};
  validateTag(options: {appRoot: string; tag: string; appVersion: string}): string[];
  describeChanges(options: {appRoot: string; from: string; releaseFilesOnly?: boolean}): {problems: string[]; files: string[]; outside: string[]; dependenciesChanged: boolean};
};
// Loaded by a variable name so the strict typecheck does not need a declaration file for the plain-JavaScript script.
const specifier = '../scripts/check-release.mjs';
const gate = await import(specifier) as Gate;

const CANDIDATE = '0.0.0-candidate.g131e5b17def5';
// The SDK's unpublished local release artifacts (a real version, installed from candidates/ as files). Its registry spelling
// would be identical, so the fixtures name it explicitly to be shaped as files.
const LOCAL_RELEASE = '0.7.6-rc.1';
const isLocal = (sdk: string) => sdk === LOCAL_RELEASE || sdk.startsWith('0.0.0-candidate.');
// The committed tree installs managed local inputs while candidates/ exists; an RC or stable release tree has retired it.
const committedTreeIsLocal = () => existsSync(join(root, 'candidates')) && existsSync(join(root, 'pnpm-lock.yaml'));
const TAG_PREFIX = 'ansari-faithful-answers-v';
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
type Fixture = {sdk: string; appVersion: string; stackSpec?: string; extraDirect?: Record<string, string>; lockTransform?: (lock: string) => string; keepOverrides?: boolean};
const SIBLINGS = ['core', 'components', 'mcp', 'react'];
const PEERS = '(react-dom@19.3.1(react@19.3.1))(react@19.3.1)';
/** Where one fixture SDK package comes from: the managed candidate tarball (candidate-shaped) or the registry (registry-shaped). */
function fixtureSource(sdk: string, name: string) {
  if (!isLocal(sdk)) return {ref: sdk, resolution: `{integrity: sha512-${name}fixtureintegrity==}`};
  const tarball = `file:candidates/saga-${sdk}/saga-a2ui-${name}-${sdk}.tgz`;
  return {ref: tarball, resolution: `{integrity: sha512-${name}fixtureintegrity==, tarball: ${tarball}}`};
}
/**
 * A small lockfile written from nothing but the fixture SDK version, in the shape pnpm records it: candidate tarballs for a
 * `0.0.0-candidate.*` version, registry releases with integrity hashes otherwise. It is deliberately not derived from the
 * committed pnpm-lock.yaml, so these tests behave the same whether the committed tree still carries the private candidate
 * or has already been switched to a real registry SDK.
 */
function syntheticLock(sdk: string, specifier: string): string {
  const stack = fixtureSource(sdk, 'react-mcp-stack');
  const packages = ['react-mcp-stack', ...SIBLINGS].map(name => {
    const {ref, resolution} = fixtureSource(sdk, name);
    return `  '@saga-a2ui/${name}@${ref}':\n    resolution: ${resolution}\n`;
  }).join('\n');
  const snapshots = ['react-mcp-stack', ...SIBLINGS].map(name => {
    const {ref} = fixtureSource(sdk, name);
    const deps = name === 'react-mcp-stack' ? SIBLINGS : name === 'core' ? [] : ['core'];
    const body = deps.map(dep => `      '@saga-a2ui/${dep}': ${fixtureSource(sdk, dep).ref}\n`).join('');
    return `  '@saga-a2ui/${name}@${ref}':\n${body ? `    dependencies:\n${body}` : '    {}\n'}`;
  }).join('\n');
  const specifierLine = isLocal(specifier) ? fixtureSource(specifier, 'react-mcp-stack').ref : specifier;
  return [
    "lockfileVersion: '9.0'", '',
    'importers:', '',
    '  .:', '    dependencies:',
    "      '@saga-a2ui/react-mcp-stack':",
    `        specifier: ${specifierLine}`,
    `        version: ${stack.ref}${PEERS}`, '',
    'packages:', '', packages, 'snapshots:', '', snapshots, '',
  ].join('\n');
}
/** pnpm-workspace.yaml: the unrelated override always, and the managed candidate overrides only when asked. */
function syntheticWorkspace(sdk: string, withOverrides: boolean): string {
  const lines = ['packages: []', 'overrides:', "  '@a2ui/markdown-it': '0.2.1'"];
  if (withOverrides) {
    for (const name of [...SIBLINGS, 'react-mcp-stack']) lines.push(`  '@saga-a2ui/${name}': 'file:./candidates/saga-${sdk}/saga-a2ui-${name}-${sdk}.tgz'`);
  }
  return `${lines.join('\n')}\n`;
}
/** Writes a repository-shaped fixture (apps/ansari-faithful-answers + plugin) and returns its application folder. */
function writeApp(repo: string, fixture: Fixture): string {
  const app = join(repo, 'apps/ansari-faithful-answers');
  mkdirSync(join(app, 'src'), {recursive: true});
  mkdirSync(join(repo, 'plugin'), {recursive: true});
  const deps = {...manifest.dependencies, '@saga-a2ui/react-mcp-stack': fixture.stackSpec ?? fixture.sdk, ...fixture.extraDirect};
  writeFileSync(join(app, 'package.json'), JSON.stringify({...manifest, version: fixture.appVersion, dependencies: deps}, null, 2));
  writeFileSync(join(app, 'src/version.ts'), `// One application identity, shared by the server and built view.\nexport const APP_VERSION = '${fixture.appVersion}';\n`);
  writeFileSync(join(repo, 'plugin/plugin.json'), JSON.stringify({name: 'ansari-faithful-answers-dev', version: fixture.appVersion}, null, 2));
  writeFileSync(join(app, 'pnpm-lock.yaml'), (fixture.lockTransform ?? (text => text))(syntheticLock(fixture.sdk, fixture.stackSpec ?? fixture.sdk)));
  writeFileSync(join(app, 'pnpm-workspace.yaml'), syntheticWorkspace(fixture.sdk, fixture.keepOverrides === true));
  return app;
}
function disposableRepo<T>(body: (repo: string) => T): T {
  const repo = mkdtempSync(join(tmpdir(), 'ansari-release-'));
  try { return body(repo); } finally { rmSync(repo, {recursive: true, force: true}); }
}
const validate = (fixture: Fixture, target: string) => disposableRepo(repo => gate.validateRelease({appRoot: writeApp(repo, fixture), target}).problems);
const RC: Fixture = {sdk: '0.7.0-rc.1', appVersion: '0.15.0-rc.1'};
const STABLE: Fixture = {sdk: '0.7.0', appVersion: '0.15.0'};

describe('release input validation (fixture inputs, no registry)', () => {
  it('requires a named environment', () => {
    assert.throws(() => gate.validateRelease({appRoot: root}), /Name the environment/);
    assert.throws(() => gate.validateRelease({appRoot: root, target: 'staging'}), /Name the environment/);
  });

  it('accepts exact public inputs: an RC for Beta, and a stable release for Production', () => {
    assert.deepEqual(validate(RC, 'beta'), []);
    assert.deepEqual(validate(STABLE, 'beta'), []);
    assert.deepEqual(validate(STABLE, 'production'), []);
    // The stack alone is the direct dependency; its siblings are resolved through it.
    disposableRepo(repo => {
      const result = gate.validateRelease({appRoot: writeApp(repo, STABLE), target: 'production'});
      assert.deepEqual([...new Set(result.packages.map(entry => entry.name))].sort(), ['@saga-a2ui/components', '@saga-a2ui/core', '@saga-a2ui/mcp', '@saga-a2ui/react', '@saga-a2ui/react-mcp-stack']);
      assert.ok(result.packages.every(entry => entry.version === '0.7.0'));
    });
  });

  it('keeps Production for stable inputs: no prerelease SDK and no prerelease app version', () => {
    assert.match(validate({...STABLE, sdk: '0.7.0-rc.1'}, 'production').join('\n'), /prerelease; Production needs the stable SDK/);
    assert.match(validate({...STABLE, appVersion: '0.15.0-rc.1'}, 'production').join('\n'), /Production releases a stable app version/);
  });

  for (const floating of ['next', 'latest', '^0.7.0', '~0.7.0', '0.7.x', '*', 'workspace:*', 'catalog:', 'link:../saga', 'file:./saga.tgz', 'github:MachineWisdomAI/saga-a2ui']) {
    it(`rejects the floating or non-registry specifier "${floating}" for Beta and Production`, () => {
      for (const target of ['beta', 'production']) {
        assert.match(validate({...STABLE, stackSpec: floating}, target).join('\n'), /is not an exact version/, `${target} ${floating}`);
      }
    });
  }

  it('rejects inconsistent SDK siblings in the resolved graph', () => {
    const skewed = {...STABLE, lockTransform: (lock: string) => lock.replace("'@saga-a2ui/core@0.7.0'", "'@saga-a2ui/core@0.6.9'").replace("'@saga-a2ui/core': 0.7.0", "'@saga-a2ui/core': 0.6.9")};
    for (const target of ['beta', 'production']) assert.match(validate(skewed, target).join('\n'), /siblings are inconsistent/);
    const wrongPin = {...STABLE, lockTransform: (lock: string) => lock.replaceAll('0.7.0', '0.7.1')};
    assert.match(validate({...wrongPin, stackSpec: '0.7.0'}, 'beta').join('\n'), /siblings are 0\.7\.1, but the direct pin is 0\.7\.0|is stale/);
  });

  it('rejects a lockfile that was not resolved for the committed pin', () => {
    const stale = {...STABLE, lockTransform: (lock: string) => lock.replace(/(react-mcp-stack':\n {8}specifier: )0\.7\.0/, '$10.6.0')};
    assert.match(validate(stale, 'beta').join('\n'), /pnpm-lock\.yaml is stale/);
  });

  it('rejects a redundant direct SAGA dependency instead of requiring one', () => {
    for (const sibling of ['components', 'mcp', 'react']) {
      assert.match(validate({...STABLE, extraDirect: {[`@saga-a2ui/${sibling}`]: '0.7.0'}}, 'production').join('\n'), new RegExp(`@saga-a2ui/${sibling} is a redundant direct dependency`));
    }
  });

  it('rejects a synthetic candidate-shaped tree for Beta and Production, and keeps it for Dev', () => {
    // Independent of the committed tree: a candidate lockfile with its overrides, as the Dev rehearsal installs it.
    const candidate = {...RC, sdk: CANDIDATE, appVersion: '0.15.0', keepOverrides: true};
    assert.deepEqual(validate(candidate, 'dev'), []);
    for (const target of ['beta', 'production']) {
      const text = validate(candidate, target).join('\n');
      assert.match(text, /private SAGA candidate installed from candidates\//);
      assert.match(text, /pnpm-workspace\.yaml overrides/);
      assert.match(text, /not public registry releases/);
    }
    // Registry-shaped inputs are accepted with the same helpers: the fixtures do not depend on the candidate spelling.
    assert.deepEqual(validate({...RC, keepOverrides: false}, 'beta'), []);
  });

  it('rejects a synthetic local-release-artifacts tree for Beta and Production, and keeps it for Dev', () => {
    // Final SDK release artifacts at their real version, installed as files: not a registry install, so no public environment takes them.
    const local = {sdk: LOCAL_RELEASE, appVersion: '0.15.0-rc.1', keepOverrides: true};
    assert.deepEqual(validate(local, 'dev'), []);
    for (const target of ['beta', 'production']) {
      const text = validate(local, target).join('\n');
      assert.match(text, /unpublished local release artifacts installed from candidates\//);
      assert.match(text, /Local files are not a registry install/);
      assert.match(text, /pnpm-workspace\.yaml overrides/);
      assert.match(text, /not public registry releases/);
    }
    // The same version resolved from the registry is accepted: the refusal is about where the bytes come from.
    assert.deepEqual(validate({sdk: LOCAL_RELEASE, appVersion: '0.15.0-rc.1', keepOverrides: false, lockTransform: lock => lock.replaceAll(/file:candidates\/saga-0\.7\.6-rc\.1\/saga-a2ui-[a-z-]+-0\.7\.6-rc\.1\.tgz/g, '0.7.6-rc.1').replaceAll(/, tarball: 0\.7\.6-rc\.1/g, '')}, 'beta'), []);
    // A file tarball outside candidates/ or with mismatched directory and file versions is no managed input, even for Dev.
    const stray = {sdk: LOCAL_RELEASE, appVersion: '0.15.0-rc.1', keepOverrides: true, lockTransform: (lock: string) => lock.replaceAll('file:candidates/saga-0.7.6-rc.1/', 'file:vendor/')};
    assert.match(validate(stray, 'dev').join('\n'), /must be a managed tarball under candidates\//);
  });

  it('rejects the committed local-input tree for Beta and Production while it is still installed from files', () => {
    // Skipped once the committed tree carries a real registry SDK (RC preparation removes candidates/).
    if (!committedTreeIsLocal()) return;
    assert.deepEqual(gate.validateRelease({appRoot: root, target: 'dev'}).problems, []);
    for (const target of ['beta', 'production']) {
      const text = gate.validateRelease({appRoot: root, target}).problems.join('\n');
      assert.match(text, /(?:private SAGA candidate|unpublished local release artifacts) installed from candidates\//);
      assert.match(text, /pnpm-workspace\.yaml overrides/);
      assert.match(text, /not public registry releases/);
    }
    // Candidate overrides left behind on an otherwise public pin are refused as well.
    assert.match(validate({...STABLE, keepOverrides: true}, 'beta').join('\n'), /pnpm-workspace\.yaml overrides/);
    assert.match(validate({...STABLE, sdk: CANDIDATE, appVersion: '0.15.0'}, 'beta').join('\n'), /private SAGA candidate/);
  });

  it('keeps the documented Dev rehearsal option, and still refuses floating Dev inputs', () => {
    assert.deepEqual(validate({...STABLE, sdk: CANDIDATE}, 'dev'), []);
    assert.deepEqual(validate(RC, 'dev'), []);
    assert.match(validate({...STABLE, stackSpec: 'next'}, 'dev').join('\n'), /not an exact version/);
  });

  it('requires one release version across package.json, src/version.ts and the plugin manifest', () => {
    const problems = disposableRepo(repo => {
      const app = writeApp(repo, STABLE);
      writeFileSync(join(app, 'src/version.ts'), "export const APP_VERSION = '0.15.1';\n");
      writeFileSync(join(repo, 'plugin/plugin.json'), JSON.stringify({version: '0.14.0'}));
      return gate.validateRelease({appRoot: app, target: 'production'}).problems.join('\n');
    });
    assert.match(problems, /APP_VERSION \(0\.15\.1\) differs/);
    assert.match(problems, /plugin\/plugin\.json version \(0\.14\.0\) differs/);
  });
});

describe('registry validation (injected lookups; the real registry is consulted only by the CLI)', () => {
  const packages = ['core', 'components', 'mcp', 'react', 'react-mcp-stack'].map(name => ({name: `@saga-a2ui/${name}`, version: '0.7.0'}));
  it('verifies every distinct sibling and reports each one that is missing or different', () => {
    const all = gate.verifyRegistry([...packages, ...packages], spec => spec.slice(spec.lastIndexOf('@') + 1));
    assert.equal(all.verified.length, 5);
    assert.deepEqual(all.failed, []);
    const partial = gate.verifyRegistry(packages, spec => {
      if (spec.includes('react-mcp-stack')) throw new Error('E404 Not Found');
      return spec.includes('/mcp@') ? '0.7.1' : '0.7.0';
    });
    assert.equal(partial.verified.length, 3);
    assert.equal(partial.failed.length, 2);
    assert.match(partial.failed.join('\n'), /react-mcp-stack@0\.7\.0: not found in the public registry/);
    assert.match(partial.failed.join('\n'), /mcp@0\.7\.0: the registry reported 0\.7\.1/);
  });
});

// The same checks run twice: once on the plain checkout path, and once through a symlink to the checkout. Git resolves
// the symlink, so the second layout reproduces a macOS /var/folders -> /private/var/folders temporary directory on any host.
const LAYOUTS = [{name: 'direct checkout path', symlinked: false}, {name: 'symlinked checkout path', symlinked: true}];
for (const layout of LAYOUTS) describe(`tag-based source selection in a disposable repository (${layout.name})`, () => {
  const disposable = <T>(body: (repo: string) => T): T => {
    if (!layout.symlinked) return disposableRepo(body);
    const parent = mkdtempSync(join(tmpdir(), 'ansari-release-link-'));
    const real = join(parent, 'real');
    const link = join(parent, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      assert.notEqual(realpathSync(link), link, 'the checkout path is a symlink');
      return body(link);
    } finally { rmSync(parent, {recursive: true, force: true}); }
  };
  const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'rehearsal', GIT_AUTHOR_EMAIL: 'rehearsal@example.invalid', GIT_COMMITTER_NAME: 'rehearsal', GIT_COMMITTER_EMAIL: 'rehearsal@example.invalid'};
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const commit = (repo: string, message: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  const RC_TAG = 'ansari-faithful-answers-v0.15.0-rc.1';
  const STABLE_TAG = 'ansari-faithful-answers-v0.15.0';

  it('builds an RC from its tag, derives stable from that tag alone, and never rewrites a tag', () => {
    disposable(repo => {
      git(repo, 'init', '-q', '-b', 'main');
      // The qualified source: the candidate-era tree stays as it was; RC preparation is one commit on top of it.
      const app = writeApp(repo, {...RC, sdk: CANDIDATE, appVersion: '0.15.0', keepOverrides: true});
      const qualified = commit(repo, 'qualified source');
      writeApp(repo, RC);
      const rc = commit(repo, 'chore(release): prepare 0.15.0-rc.1');
      git(repo, 'tag', '-a', RC_TAG, '-m', 'RC');
      assert.equal(git(repo, 'rev-parse', `${RC_TAG}^{commit}`), rc);

      // What RC preparation changed: dependency inputs, so the affected checks belong on Dev before tagging.
      const prep = gate.describeChanges({appRoot: app, from: qualified});
      assert.equal(prep.dependenciesChanged, true);
      assert.ok(prep.files.includes('apps/ansari-faithful-answers/pnpm-lock.yaml'));

      // Unrelated work lands on main after the RC was tagged.
      writeFileSync(join(app, 'src/unrelated.ts'), 'export const later = true;\n');
      const later = commit(repo, 'feat: unrelated later work');

      // The checkout of the RC tag validates; the moved branch head does not claim to be the tag.
      git(repo, 'checkout', '-q', '--detach', RC_TAG);
      assert.deepEqual(gate.validateTag({appRoot: app, tag: RC_TAG, appVersion: '0.15.0-rc.1'}), []);
      assert.deepEqual(gate.validateRelease({appRoot: app, target: 'beta'}).problems, []);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), rc, 'the build input is the tagged commit');
      assert.ok(!existsSync(join(app, 'src/unrelated.ts')), 'later branch work is not in the RC checkout');
      git(repo, 'checkout', '-q', 'main');
      assert.match(gate.validateTag({appRoot: app, tag: RC_TAG, appVersion: '0.15.0-rc.1'}).join('\n'), /points at .*but the checked-out HEAD/);
      git(repo, 'checkout', '-q', '--detach', RC_TAG);

      // A tag is immutable: git refuses to re-create it, and a lightweight or misnamed tag does not qualify.
      assert.throws(() => git(repo, 'tag', '-a', RC_TAG, '-m', 'again'), /already exists/);
      git(repo, 'tag', 'lightweight-rc');
      assert.match(gate.validateTag({appRoot: app, tag: 'lightweight-rc', appVersion: '0.15.0-rc.1'}).join('\n'), /must be ansari-faithful-answers-v0\.15\.0-rc\.1/);
      git(repo, 'tag', `${TAG_PREFIX}0.15.0-rc.1-light`);
      assert.match(gate.validateTag({appRoot: app, tag: `${TAG_PREFIX}0.15.0-rc.1-light`, appVersion: '0.15.0-rc.1-light'}).join('\n'), /not an annotated tag/);
      writeFileSync(join(app, 'dirty.txt'), 'x');
      assert.match(gate.validateTag({appRoot: app, tag: RC_TAG, appVersion: '0.15.0-rc.1'}).join('\n'), /working tree is not clean/);
      rmSync(join(app, 'dirty.txt'));

      // Stable starts from the accepted RC tag, not from main: only the release files change.
      git(repo, 'switch', '-q', '-c', 'release/0.15.0', RC_TAG);
      writeApp(repo, STABLE);
      const stable = commit(repo, 'chore(release): promote version and pin the stable SDK');
      git(repo, 'tag', '-a', STABLE_TAG, '-m', 'stable');
      const changes = gate.describeChanges({appRoot: app, from: RC_TAG, releaseFilesOnly: true});
      assert.deepEqual(changes.problems, []);
      assert.deepEqual(changes.outside, []);
      assert.equal(changes.dependenciesChanged, true, 'a changed SDK is an executable dependency change: qualify it on Dev');
      assert.deepEqual([...changes.files].sort(), ['apps/ansari-faithful-answers/package.json', 'apps/ansari-faithful-answers/pnpm-lock.yaml', 'apps/ansari-faithful-answers/src/version.ts', 'plugin/plugin.json']);
      assert.ok(!existsSync(join(app, 'src/unrelated.ts')), 'the stable branch excludes later main work');
      assert.notEqual(git(repo, 'merge-base', stable, later), stable, 'stable is not on main');
      assert.deepEqual(gate.validateTag({appRoot: app, tag: STABLE_TAG, appVersion: '0.15.0'}), []);
      assert.deepEqual(gate.validateRelease({appRoot: app, target: 'production'}).problems, []);
      assert.notEqual(stable, rc, 'the stable release is a new commit, so a new artifact');
      assert.equal(git(repo, 'rev-parse', `${RC_TAG}^{commit}`), rc, 'the RC tag still names the RC commit');

      // Taking main's unrelated work into the stable branch is refused.
      writeFileSync(join(app, 'src/unrelated.ts'), 'export const later = true;\n');
      commit(repo, 'unrelated change on the stable branch');
      const polluted = gate.describeChanges({appRoot: app, from: RC_TAG, releaseFilesOnly: true});
      assert.match(polluted.problems.join('\n'), /apps\/ansari-faithful-answers\/src\/unrelated\.ts changed since/);
    });
  });

  it('screens the content of the allowed release files, not just their paths', () => {
    const stableFrom = (change: (app: string, repo: string) => void) => disposable(repo => {
      git(repo, 'init', '-q', '-b', 'main');
      const app = writeApp(repo, {...STABLE, appVersion: '0.15.0-rc.1'});
      commit(repo, 'rc');
      git(repo, 'tag', '-a', RC_TAG, '-m', 'RC');
      writeApp(repo, STABLE);
      change(app, repo);
      commit(repo, 'promote');
      return gate.describeChanges({appRoot: app, from: RC_TAG, releaseFilesOnly: true});
    });
    const edit = (file: string, transform: (text: string) => string) => { writeFileSync(file, transform(readFileSync(file, 'utf8'))); };

    // Executable code appended to src/version.ts stays inside the allowed path but is refused.
    const code = stableFrom(app => edit(join(app, 'src/version.ts'), text => `${text}export const injected = () => process.env;\n`));
    assert.match(code.problems.join('\n'), /src\/version\.ts changed since .* beyond the release version and the SDK pin/);
    assert.ok(code.outside.includes('apps/ansari-faithful-answers/src/version.ts'));

    // A changed package script or an unrelated dependency inside package.json is refused; the SDK pin and version are not.
    const script = stableFrom(app => edit(join(app, 'package.json'), text => { const parsed = JSON.parse(text); parsed.scripts = {...parsed.scripts, postinstall: 'node x.js'}; return JSON.stringify(parsed, null, 2); }));
    assert.match(script.problems.join('\n'), /package\.json changed since .* beyond the release version and the SDK pin/);
    const extra = stableFrom(app => edit(join(app, 'package.json'), text => { const parsed = JSON.parse(text); parsed.dependencies.leftpad = '1.0.0'; return JSON.stringify(parsed, null, 2); }));
    assert.match(extra.problems.join('\n'), /package\.json changed since .* beyond the release version and the SDK pin/);

    // Plugin settings other than the version are refused; a workspace-file change is refused as a path outside the release set.
    const plugin = stableFrom((_app, repo) => writeFileSync(join(repo, 'plugin/plugin.json'), JSON.stringify({name: 'other', version: '0.15.0'})));
    assert.match(plugin.problems.join('\n'), /plugin\/plugin\.json changed since .* beyond the release version and the SDK pin/);
    const workspace = stableFrom(app => edit(join(app, 'pnpm-workspace.yaml'), text => `${text}  'left-pad': '1.0.0'\n`));
    assert.match(workspace.problems.join('\n'), /pnpm-workspace\.yaml changed since/);

    // The legitimate derivation (version mirrors and the SDK pin only) passes the same screen.
    assert.deepEqual(stableFrom(() => undefined).problems, []);
  });

  it('a stable derivation whose only change is the version still reports unchanged executable dependencies', () => {
    disposable(repo => {
      git(repo, 'init', '-q', '-b', 'main');
      const app = writeApp(repo, {...STABLE, appVersion: '0.15.0-rc.1'});
      commit(repo, 'rc');
      git(repo, 'tag', '-a', RC_TAG, '-m', 'RC');
      writeApp(repo, STABLE);
      commit(repo, 'promote');
      const changes = gate.describeChanges({appRoot: app, from: RC_TAG, releaseFilesOnly: true});
      assert.deepEqual(changes.problems, []);
      assert.equal(changes.dependenciesChanged, false);
    });
  });
});

describe('the release CLI', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/check-release.mjs'), ...args], {cwd: root, encoding: 'utf8'});
  it('has no default environment', () => {
    const result = run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Name the environment/);
  });
  it('says plainly when the registry was not consulted, and fails the local-input tree for Beta and Production', () => {
    if (!committedTreeIsLocal()) return;
    const beta = run('--target', 'beta', '--no-registry');
    assert.equal(beta.status, 1);
    assert.match(beta.stdout, /Registry NOT checked/);
    assert.match(beta.stderr, /Release check FAILED for beta/);
    assert.equal(run('--target', 'dev').status, 0);
  });
});

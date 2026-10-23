// The release-input gate for one named environment. It reads files and, only when asked, the public npm
// registry. It publishes, tags and deploys nothing, and it changes no file.
//
//   node scripts/check-release.mjs --target dev|beta|production [--no-registry] [--tag TAG] [--from REF [--release-files-only]]
//
//   --target       required; there is no default environment.
//   --no-registry  skip the npm registry lookups. The report then says the registry was NOT checked, so a
//                  structural pass is never mistaken for a verified public release.
//   --tag TAG      the source tag being built: it must be the annotated app tag `ansari-faithful-answers-v<version>`,
//                  point at HEAD, and the tree must be clean.
//   --from REF     report what changed from REF (the qualified source, or the accepted RC tag) to HEAD, and whether any
//                  executable dependency input changed (which then needs the Dev checks before a deployment).
//   --release-files-only  with --from: a screen, not a proof. It fails when a file other than package.json,
//                  src/version.ts, plugin/plugin.json or pnpm-lock.yaml changed, when those three small files changed
//                  beyond their version fields and the SDK pin, or when REF is not an ancestor of HEAD. The CONTENT of
//                  pnpm-lock.yaml is not diffed (validateRelease checks only that the graph is consistent registry
//                  releases), so the full `git diff REF HEAD` must still be reviewed before qualification and tagging.
//
// Dev tolerates exact local SAGA tarballs under candidates/ (this repository commits none). Beta and
// Production accept only exact, public, consistent SAGA releases. Production additionally accepts no prerelease.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const STACK = '@saga-a2ui/react-mcp-stack';
export const TARGETS = ['dev', 'beta', 'production'];
export const TAG_PREFIX = 'ansari-faithful-answers-v';
/** Files a stable derivation from an accepted RC may change: version mirrors, the SDK pin and the lockfile. */
export const RELEASE_FILES = [
  'apps/ansari-faithful-answers/package.json',
  'apps/ansari-faithful-answers/pnpm-lock.yaml',
  'apps/ansari-faithful-answers/src/version.ts',
  'plugin/plugin.json',
];
const canonical = value => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
const withoutVersion = text => { const parsed = JSON.parse(text); parsed.version = null; return parsed; };
/**
 * For the small release files: the content with only the allowed fields (release version, SDK pin) blanked, so two
 * revisions compare equal exactly when they differ in nothing else. The lockfile is not here: its content is not diffed.
 */
const RELEASE_CONTENT = {
  'apps/ansari-faithful-answers/package.json': text => {
    const parsed = withoutVersion(text);
    if (parsed.dependencies?.[STACK] !== undefined) parsed.dependencies[STACK] = null;
    return canonical(parsed);
  },
  'apps/ansari-faithful-answers/src/version.ts': text => text.replace(/(export const APP_VERSION = )'[^']*'/, "$1'<version>'"),
  'plugin/plugin.json': text => canonical(withoutVersion(text)),
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANDIDATE = /^0\.0\.0-candidate\.g[0-9a-f]{12}$/;
/**
 * A managed local SAGA tarball as the lockfile records it: `file:candidates/saga-<version>/saga-a2ui-<name>-<version>.tgz`,
 * the directory and file naming one version. That is a snapshot candidate (0.0.0-candidate.g...) or the SDK's unpublished
 * local release artifacts (a real version such as 0.7.6-rc.1). Neither is a registry release.
 */
const LOCAL_FILE = /^file:candidates\/saga-([^/]+)\/saga-a2ui-(?:core|components|mcp|react|lit|lit-mcp-stack|react-mcp-stack)-\1\.tgz$/;
const localVersion = ref => LOCAL_FILE.exec(ref)?.[1];
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const isPrerelease = version => version.includes('-');
const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** The text of one top-level section of pnpm-lock.yaml. */
function section(lock, name) {
  const match = new RegExp(`^${name}:\\n((?:(?:[ ]+.*)?\\n)*)`, 'm').exec(lock);
  return match ? match[1] : '';
}

/** Direct SAGA dependencies of the application as the lockfile recorded them. */
function lockedDirect(lock) {
  const found = [];
  const pattern = /^ {6}'?(@saga-a2ui\/[^':]+)'?:\n {8}specifier: (.+)\n {8}version: (.+)$/gm;
  for (const [, name, specifier, version] of section(lock, 'importers').matchAll(pattern)) {
    found.push({name, specifier: specifier.replace(/^'|'$/g, ''), version: version.replace(/^'|'$/g, '').replace(/\(.*$/, '')});
  }
  return found;
}

/** Every resolved `@saga-a2ui/*` package in the lockfile, with its version and where the bytes come from. */
function lockedPackages(lock) {
  const body = section(lock, 'packages');
  const result = [];
  for (const [, key, block] of body.matchAll(/^ {2}'?([^'\n]+?)'?:\n((?: {4}.*\n?)*)/gm)) {
    const split = /^(@saga-a2ui\/[^@]+)@(.+)$/.exec(key);
    if (!split) continue;
    const [, name, ref] = split;
    const resolution = /resolution: \{(.*)\}/.exec(block)?.[1] ?? '';
    const tarball = /tarball: (\S+?)[,}]?(?:\s|$)/.exec(resolution)?.[1];
    const direct = /(?:directory|repo|commit):/.test(resolution);
    const file = ref.startsWith('file:');
    result.push({
      name,
      ref,
      version: file ? localVersion(ref) : ref,
      source: file ? 'file' : tarball ? 'tarball' : direct ? 'git-or-directory' : /integrity: sha512-/.test(resolution) ? 'registry' : 'unverified',
    });
  }
  return result;
}

/** pnpm-workspace.yaml `overrides:` entries for SAGA packages. */
function sagaOverrides(workspace) {
  return [...(workspace ?? '').matchAll(/^ {2}'?(@saga-a2ui\/[^':]+)'?: '?([^'\n]+)'?$/gm)].map(([, name, value]) => ({name, value}));
}

/**
 * Validates the release inputs of one application folder for one environment.
 * Returns {problems, packages, facts}; problems is empty when the inputs are acceptable for that environment.
 */
export function validateRelease({appRoot = defaultRoot, target} = {}) {
  if (!TARGETS.includes(target)) throw new Error(`Name the environment: --target ${TARGETS.join('|')} (got ${target ?? 'none'}).`);
  const problems = [];
  const manifest = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const lock = read(path.join(appRoot, 'pnpm-lock.yaml'));
  const workspace = read(path.join(appRoot, 'pnpm-workspace.yaml'));
  const release = target !== 'dev';

  // 1. The direct stack dependency: present, exact, public (Beta/Production), and the only direct SAGA dependency.
  const direct = Object.entries({...manifest.dependencies, ...manifest.devDependencies}).filter(([name]) => name.startsWith('@saga-a2ui/'));
  const stack = manifest.dependencies?.[STACK];
  if (stack === undefined) problems.push(`${STACK} is not a direct dependency.`);
  for (const [name, spec] of direct) {
    if (name !== STACK) problems.push(`${name} is a redundant direct dependency: the application reaches it through ${STACK}; remove it.`);
    if (!EXACT.test(spec)) problems.push(`${name}: "${spec}" is not an exact version. Floating tags (next, latest), ranges, file:, link:, workspace: and git specifiers cannot be released; resolve and pin an exact version.`);
  }
  if (stack !== undefined && CANDIDATE.test(stack) && release) problems.push(`${STACK}@${stack} is a private SAGA candidate installed from candidates/, not a public release. ${target} accepts only an exact public release.`);
  if (stack !== undefined && EXACT.test(stack) && target === 'production' && isPrerelease(stack) && !CANDIDATE.test(stack)) problems.push(`${STACK}@${stack} is a prerelease; Production needs the stable SDK release supplied by its owner.`);

  // 2. No SAGA override may stand in for a release on Beta/Production.
  const overrides = sagaOverrides(workspace);
  const manifestOverrides = Object.keys({...manifest.overrides, ...manifest.pnpm?.overrides}).filter(name => name.startsWith('@saga-a2ui/'));
  if (release) {
    if (overrides.length > 0) problems.push(`pnpm-workspace.yaml overrides ${overrides.map(entry => entry.name).join(', ')} (${[...new Set(overrides.map(entry => entry.value.split(':')[0]))].join(', ')}): remove every SAGA override for ${target}.`);
    for (const name of manifestOverrides) problems.push(`package.json overrides ${name}: remove every SAGA override for ${target}.`);
  }

  // 3. The resolved graph: one version across every SAGA sibling, equal to the direct pin, from the registry.
  let packages = [];
  if (lock === undefined) problems.push('pnpm-lock.yaml is missing: commit the resolved graph.');
  else {
    const locked = lockedDirect(lock);
    const lockedStack = locked.filter(entry => entry.name === STACK);
    if (lockedStack.length !== 1) problems.push(`pnpm-lock.yaml records no direct ${STACK} dependency.`);
    else {
      // An override rewrites the locked specifier of the direct dependency to its tarball; compare the version it names.
      const resolvedFor = lockedStack[0].specifier.startsWith('file:') ? localVersion(lockedStack[0].specifier) : lockedStack[0].specifier;
      if (resolvedFor !== stack) problems.push(`pnpm-lock.yaml is stale: it was resolved for "${lockedStack[0].specifier}", package.json says "${stack}".`);
    }
    for (const entry of locked.filter(item => item.name !== STACK)) problems.push(`pnpm-lock.yaml records a redundant direct dependency ${entry.name}.`);
    packages = lockedPackages(lock);
    if (!packages.some(entry => entry.name === STACK)) problems.push(`pnpm-lock.yaml resolves no ${STACK}.`);
    const versions = [...new Set(packages.map(entry => entry.version ?? `unrecognised:${entry.ref}`))];
    if (versions.length > 1) problems.push(`The resolved SAGA siblings are inconsistent: ${packages.map(entry => `${entry.name}@${entry.version ?? entry.ref}`).join(', ')}. They must share one version.`);
    if (versions.length === 1 && stack !== undefined && versions[0] !== stack) problems.push(`The resolved SAGA siblings are ${versions[0]}, but the direct pin is ${stack}.`);
    const notRegistry = packages.filter(entry => entry.source !== 'registry');
    if (release && notRegistry.length > 0) problems.push(`${notRegistry.length} resolved SAGA package(s) are not public registry releases with an integrity hash (${[...new Set(notRegistry.map(entry => entry.source))].join(', ')}); ${target} accepts only registry releases: ${notRegistry.map(entry => entry.name).join(', ')}.`);
    const localRelease = packages.filter(entry => entry.source === 'file' && entry.version !== undefined && !CANDIDATE.test(entry.version));
    if (release && localRelease.length > 0) problems.push(`${localRelease.length} resolved SAGA package(s) are unpublished local release artifacts installed from candidates/ (${[...new Set(localRelease.map(entry => entry.version))].join(', ')}), not public registry releases: ${target} accepts only a release that is on the public registry. Local files are not a registry install.`);
    for (const entry of packages) {
      if (entry.version !== undefined && !EXACT.test(entry.version)) problems.push(`${entry.name}@${entry.ref} is not an exact version.`);
      if (!release && entry.source === 'file' && localVersion(entry.ref) === undefined) problems.push(`${entry.name}@${entry.ref}: a file: installation must be a managed tarball under candidates/ (snapshot candidate or local release artifacts).`);
      if (!release && !['file', 'registry'].includes(entry.source)) problems.push(`${entry.name}@${entry.ref}: ${entry.source} installations are not releasable.`);
    }
  }

  // 4. One release version in every mirror; Production accepts no prerelease app version.
  const appVersion = manifest.version;
  const mirror = /export const APP_VERSION = '([^']+)';/.exec(read(path.join(appRoot, 'src/version.ts')) ?? '')?.[1];
  const pluginFile = path.join(appRoot, '../../plugin/plugin.json');
  const plugin = read(pluginFile) === undefined ? undefined : JSON.parse(read(pluginFile)).version;
  if (!EXACT.test(appVersion ?? '')) problems.push(`package.json version "${appVersion}" is not an exact version.`);
  if (mirror !== appVersion) problems.push(`src/version.ts APP_VERSION (${mirror}) differs from package.json (${appVersion}).`);
  if (plugin !== undefined && plugin !== appVersion) problems.push(`plugin/plugin.json version (${plugin}) differs from package.json (${appVersion}).`);
  if (target === 'production' && isPrerelease(appVersion ?? '')) problems.push(`Production releases a stable app version; ${appVersion} is a prerelease. Derive stable from the accepted RC.`);

  return {problems, packages, facts: {target, appVersion, stack, siblings: [...new Set(packages.map(entry => `${entry.name}@${entry.version}`))]}};
}

/** Looks each distinct sibling up in the public registry. `view(spec)` returns the version npm reports, or throws. */
export function verifyRegistry(packages, view = npmView) {
  const verified = [];
  const failed = [];
  for (const spec of [...new Set(packages.map(entry => `${entry.name}@${entry.version}`))]) {
    try {
      const found = view(spec);
      if (found === spec.slice(spec.lastIndexOf('@') + 1)) verified.push(spec);
      else failed.push(`${spec}: the registry reported ${found}`);
    } catch (error) {
      failed.push(`${spec}: not found in the public registry (${String(error.message).split('\n')[0]})`);
    }
  }
  return {verified, failed};
}

function npmView(spec) {
  const out = execFileSync('npm', ['view', spec, 'version', '--json', '--registry=https://registry.npmjs.org'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  // Newer npm releases print a one-element array for an exact version; older ones print the bare string.
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
}

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

/** The source tag: app-scoped name for this version, annotated, at HEAD, with a clean tree. */
export function validateTag({appRoot = defaultRoot, tag, appVersion}) {
  const problems = [];
  if (tag !== `${TAG_PREFIX}${appVersion}`) problems.push(`Tag "${tag}" must be ${TAG_PREFIX}${appVersion} for app version ${appVersion}.`);
  try {
    if (git(appRoot, 'cat-file', '-t', `refs/tags/${tag}`) !== 'tag') problems.push(`${tag} is not an annotated tag.`);
    const [at, head] = [git(appRoot, 'rev-parse', `refs/tags/${tag}^{commit}`), git(appRoot, 'rev-parse', 'HEAD')];
    if (at !== head) problems.push(`${tag} points at ${at}, but the checked-out HEAD is ${head}: build from a checkout of the tag.`);
  } catch { problems.push(`Tag ${tag} does not exist in this repository.`); }
  if (git(appRoot, 'status', '--porcelain') !== '') problems.push('The working tree is not clean: build only an unmodified checkout of the tag.');
  return problems;
}

/** What changed from REF to HEAD, whether an executable dependency input changed, and any file outside the release set. */
export function describeChanges({appRoot = defaultRoot, from, releaseFilesOnly = false}) {
  const problems = [];
  // Git reports the repository root with symlinks resolved (on macOS a /var/folders checkout is /private/var/folders),
  // so resolve the app directory the same way before deriving the Git-relative prefix from the two.
  const top = realpathSync(git(appRoot, 'rev-parse', '--show-toplevel'));
  const files = git(top, 'diff', '--name-only', from, 'HEAD').split('\n').filter(Boolean);
  const appPrefix = path.relative(top, realpathSync(appRoot)).split(path.sep).join('/');
  const rel = file => `${appPrefix}/${file}`;
  const dependencyInputs = ref => {
    const manifest = JSON.parse(git(top, 'show', `${ref}:${rel('package.json')}`));
    return JSON.stringify([manifest.dependencies, manifest.devDependencies, manifest.overrides, manifest.pnpm]);
  };
  const dependenciesChanged = files.includes(rel('pnpm-lock.yaml')) || files.includes(rel('pnpm-workspace.yaml')) || dependencyInputs(from) !== dependencyInputs('HEAD');
  const outside = files.filter(file => !RELEASE_FILES.includes(file));
  // The three small release files may change only their version fields and the SDK pin. Anything else inside them
  // (code in src/version.ts, package scripts, other dependencies or plugin settings) counts as changed code.
  const beyondRelease = [];
  for (const file of files.filter(entry => entry in RELEASE_CONTENT)) {
    try {
      const [before, after] = [from, 'HEAD'].map(ref => RELEASE_CONTENT[file](git(top, 'show', `${ref}:${file}`)));
      if (before !== after) beyondRelease.push(file);
    } catch { beyondRelease.push(file); }
  }
  outside.push(...beyondRelease);
  if (releaseFilesOnly) {
    for (const file of files.filter(entry => !RELEASE_FILES.includes(entry))) problems.push(`${file} changed since ${from}; a stable derivation changes only the release version, the SDK pin and the lockfile.`);
    for (const file of beyondRelease) problems.push(`${file} changed since ${from} beyond the release version and the SDK pin.`);
    try { git(top, 'merge-base', '--is-ancestor', from, 'HEAD'); } catch { problems.push(`${from} is not an ancestor of HEAD: derive stable from the accepted RC tag.`); }
  }
  return {problems, files, outside, dependenciesChanged};
}

function parse(argv) {
  const options = {registry: true, releaseFilesOnly: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-registry') options.registry = false;
    else if (arg === '--release-files-only') options.releaseFilesOnly = true;
    else if (['--target', '--tag', '--from'].includes(arg)) options[arg.slice(2)] = argv[i += 1];
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    const {problems, packages, facts} = validateRelease({target: options.target});
    const lines = [`Release inputs for ${facts.target}: app ${facts.appVersion}, ${STACK}@${facts.stack}`];
    if (options.tag !== undefined) problems.push(...validateTag({tag: options.tag, appVersion: facts.appVersion}));
    if (options.from !== undefined) {
      const changes = describeChanges({from: options.from, releaseFilesOnly: options.releaseFilesOnly});
      problems.push(...changes.problems);
      lines.push(`Changed since ${options.from}: ${changes.files.length === 0 ? 'nothing' : changes.files.join(', ')}`);
      lines.push(changes.dependenciesChanged ? 'Executable dependency inputs CHANGED: qualify the affected checks on Dev before any deployment of this release; it is a new artifact, not the earlier binary.' : 'Executable dependency inputs unchanged.');
      if (changes.outside.length > 0) lines.push(`Outside the release version and SDK pin (code changed, rerun the affected Dev checks): ${changes.outside.join(', ')}`);
      if (options.releaseFilesOnly) lines.push(`Path and field screen only: the content of pnpm-lock.yaml was NOT diffed. Review the full \`git diff ${options.from} HEAD\` before qualification and tagging.`);
    }
    if (options.target !== 'dev' && options.registry) {
      const {verified, failed} = verifyRegistry(packages);
      for (const spec of verified) lines.push(`Registry verified: ${spec}`);
      problems.push(...failed.map(failure => `Registry: ${failure}`));
    } else if (options.target !== 'dev') lines.push('Registry NOT checked (--no-registry): this is a structural check of the files only, not a verified public release.');
    else lines.push('Dev: the structure is checked and local SAGA tarballs under candidates/ would be tolerated; use --target beta to verify the public registry release. Registry not consulted.');
    for (const line of lines) console.log(line);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      console.error(`Release check FAILED for ${facts.target} (${problems.length} problem${problems.length === 1 ? '' : 's'}).`);
      process.exit(1);
    }
    console.log(`Release check passed for ${facts.target}.`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

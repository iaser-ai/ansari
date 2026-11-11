import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Turborepo runs in strict env mode: a variable a task does not declare is hidden from it and left out of its hash.
// The tasks that run the server (`dev`, `start`) must declare every variable the source reads, the README documents.
const root = fileURLToPath(new URL('../', import.meta.url));
const RUNNING_TASKS = ['dev', 'start'] as const;

type TurboTask = {env?: string[]};
const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as {tasks: Record<string, TurboTask>};

/** Variable names in the README's `| Variable | Meaning |` table. */
function readmeVariables(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => /^\|\s*Variable\s*\|\s*Meaning\s*\|/.test(line));
  assert.notEqual(start, -1, 'README has a Variable | Meaning table');
  const names: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const match = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    assert.ok(match, `table row names one variable: ${line}`);
    names.push(match[1]!);
  }
  return names;
}

/** Environment names the source reads: `process.env.X`, `env.X` and runtime-config's `setting(env, 'X')`. */
function sourceVariables(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(match[1]!);
  for (const match of source.matchAll(/\bsetting\(\s*env\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g)) names.add(match[1]!);
  return [...names];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

test('the readme table parser reads names and rejects a malformed row', () => {
  const table = '| Variable | Meaning |\n| --- | --- |\n| `PORT` | port |\n| `A_B2` | x |\n\nprose';
  assert.deepEqual(readmeVariables(table), ['PORT', 'A_B2']);
  assert.throws(() => readmeVariables('| Variable | Meaning |\n| --- | --- |\n| PORT | unquoted |'));
  assert.throws(() => readmeVariables('no table here'));
});

test('the source scan finds every read form and ignores near misses', () => {
  const hits = sourceVariables([
    'process.env.PORT',
    'allowedList(env.MCP_ALLOWED_HOSTS, x)',
    "setting(env, 'ANSARI_RELEASE')",
    'setting( env , "RAILWAY_GIT_COMMIT_SHA" )',
  ].join('\n'));
  assert.deepEqual(sorted(hits), ['ANSARI_RELEASE', 'MCP_ALLOWED_HOSTS', 'PORT', 'RAILWAY_GIT_COMMIT_SHA']);
  assert.deepEqual(sourceVariables(['myenv.PORT', 'env.lowercase', "setting(other, 'PORT')", "settings(env, 'PORT')"].join('\n')), []);
});

test('the source scan sees the real configuration reads', () => {
  const found = sorted(sourceFiles(join(root, 'src')).flatMap(file => sourceVariables(readFileSync(file, 'utf8'))));
  // A floor, so a scan that silently matches nothing fails loudly instead of passing.
  for (const name of ['PORT', 'MCP_ALLOWED_HOSTS', 'ANSARI_API_AUTHORIZATION', 'RAILWAY_GIT_COMMIT_SHA']) {
    assert.ok(found.includes(name), `scan finds ${name}`);
  }
});

test('dev and start declare exactly the README table, which covers every variable the source reads', () => {
  const documented = sorted(readmeVariables(readFileSync(join(root, 'README.md'), 'utf8')));
  const read = sorted(sourceFiles(join(root, 'src')).flatMap(file => sourceVariables(readFileSync(file, 'utf8'))));
  assert.deepEqual(read.filter(name => !documented.includes(name)), [], 'every variable the source reads is in the README table');
  for (const task of RUNNING_TASKS) {
    const declared = turbo.tasks[task]?.env ?? [];
    assert.deepEqual(sorted(declared), documented, `${task}.env matches the README table`);
    assert.equal(declared.length, new Set(declared).size, `${task}.env has no duplicates`);
  }
});

test('turbo declares variable names only, never a value or a wildcard', () => {
  for (const [task, config] of Object.entries(turbo.tasks)) {
    for (const entry of config.env ?? []) assert.match(entry, /^[A-Z][A-Z0-9_]*$/, `${task}.env entry ${entry} is a bare name`);
  }
});

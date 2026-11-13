import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/first-load-timeline.mjs', import.meta.url));
const at = (iso: string) => Date.parse(iso);

function timeline(trials: object[], log: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'first-load-timeline-'));
  try {
    const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(join(dir, 'trials.jsonl'), jsonl(trials));
    writeFileSync(join(dir, 'app.jsonl'), jsonl(log));
    return execFileSync(process.execPath, [script, join(dir, 'trials.jsonl'), join(dir, 'app.jsonl')], {encoding: 'utf8'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

const trial = {host: 'claude', deploy: 'fresh', card: 'closed', label: 'order', first: 'card', retry: 'n-a',
  start: '2026-10-30T12:00:10.000Z', end: '2026-10-30T12:00:20.000Z'};

// `railway logs --deployment --json` lifts a JSON record's fields to the top level and adds its own `timestamp`, which is
// when Railway collected the line, in batches. The record's own `at` is when it happened.
test('a Railway record is placed by its own time, not the batch timestamp Railway added', () => {
  const out = timeline([trial], [
    {event: 'mcp.rpc', rpc: 'resources/read', rid: 'r3', at: at('2026-10-30T12:00:19.500Z'), timestamp: '2026-10-30T12:00:20.400Z', message: ''},
    {event: 'mcp.rpc', rpc: 'tools/list', rid: 'r1', at: at('2026-10-30T12:00:11.000Z'), timestamp: '2026-10-30T12:00:20.500Z', message: ''},
    {event: 'mcp.rpc', rpc: 'tools/call', rid: 'r2', at: at('2026-10-30T12:00:15.000Z'), timestamp: '2026-10-30T12:00:20.100Z', message: ''},
  ]);
  const lines = out.split('\n').filter(line => /^\s*\+[\d.]+s → /.test(line));
  assert.deepEqual(lines.map(line => line.trim()), [
    '+1.00s → tools/list [r1]',
    '+5.00s → tools/call [r2]',
    '+9.50s → resources/read [r3]',
  ]);
  assert.doesNotMatch(out, /no card read was observed/);
});

test('a Railway line without its own time falls back to the batch timestamp', () => {
  const out = timeline([trial], [
    {event: 'startup', timestamp: '2026-10-30T12:00:12.000Z', message: ''},
  ]);
  assert.match(out, /\+2\.00s · startup/);
});

test('a record wrapped in a Railway message keeps its own time', () => {
  const out = timeline([trial], [
    {timestamp: '2026-10-30T12:00:25.000Z', message: JSON.stringify({event: 'mcp.rpc', rpc: 'tools/call', rid: 'w1', at: at('2026-10-30T12:00:13.000Z')})},
  ]);
  assert.match(out, /\+3\.00s → tools\/call \[w1\]/);
});

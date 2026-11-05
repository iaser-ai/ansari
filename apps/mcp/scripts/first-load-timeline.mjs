#!/usr/bin/env node
// Joins first-load trials (scripts/first-load-trial.sh) with the server's logs, one timeline per trial (#335).
//
// Usage: node scripts/first-load-timeline.mjs <trials.jsonl> <log.jsonl>...
// Each log file holds JSON lines in any of three forms: the application's own records (`event`, with `at`),
// Railway deployment logs (`railway logs --deployment --json`: `timestamp` and the record in `message`), or Railway
// edge HTTP logs (`railway logs --http --json`: `timestamp`, path, status, duration and bytes).
//
// The server writes the records read here only while measuring (`MCP_LOG_LEVEL=debug`, which a diagnostic card
// implies); their `level` is `debug`. Without them a window shows only edge and operational lines.
//
// Records are attributed to a trial by time only: neither a server `rid` nor a card id links to the host's attempt.
// The timeline therefore says what was observed in each window, flags windows whose traffic may not be the trial's,
// and never claims that something did not happen anywhere.
import {readFileSync} from 'node:fs';

const [trialsFile, ...logFiles] = process.argv.slice(2);
if (!trialsFile || logFiles.length === 0) {
  console.error('usage: node scripts/first-load-timeline.mjs <trials.jsonl> <log.jsonl>...');
  process.exit(2);
}
const lines = file => readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
/** Records before the first window's start that still belong to it (discovery right before sending). */
const LEAD_MS = 2_000;

/**
 * One normalized entry: when, what kind, and the fields worth printing. An application record's own `at` is when it
 * happened. Railway's `timestamp` is when Railway collected the line, in batches, so it is only the fallback: preferring
 * it reorders records and moves them out of the window they belong to.
 */
function normalize(raw) {
  const time = Date.parse(raw.timestamp ?? '') || raw.at;
  if (typeof raw.message === 'string' && raw.message.startsWith('{')) {
    try { const record = JSON.parse(raw.message); return {...record, at: record.at ?? time}; } catch { /* plain text line */ }
  }
  if (raw.event) return {...raw, at: typeof raw.at === 'number' ? raw.at : time};
  const path = raw.path ?? raw.attributes?.path;
  if (path !== undefined) return {event: 'edge', at: time, ...raw};
  return undefined;
}
const entries = logFiles.flatMap(lines).map(normalize).filter(entry => entry && typeof entry.at === 'number').sort((a, b) => a.at - b.at);
const trials = lines(trialsFile);

function describe(entry, zero) {
  const t = `+${((entry.at - zero) / 1000).toFixed(2)}s`.padStart(9);
  switch (entry.event) {
    case 'mcp.rpc': return `${t} → ${entry.rpc}${entry.uri ? ` ${entry.uri}${entry.uriCurrent === false ? ' (NOT CURRENT)' : ''}` : ''}${entry.client ? ` client=${entry.client}/${entry.clientVersion}` : ''} [${entry.rid}]`;
    case 'mcp.response': return `${t} ← ${entry.rpc} ${entry.status} stream=${entry.stream} ${entry.bytes}B headers=${entry.headersMs}ms total=${entry.ms}ms${entry.errorCode === undefined ? '' : ` error=${entry.errorCode}`} [${entry.rid}]`;
    case 'view.report': return `${t} ◆ card ${entry.view} ${entry.reason}${entry.failure ? ` failure=${entry.failure}` : ''} host=${entry.host ?? '?'} origin=${entry.origin} marks=${JSON.stringify(entry.marks)}${entry.errors?.length ? ` errors=${JSON.stringify(entry.errors)}` : ''}`;
    case 'view.prepared': return `${t} ◇ serving ${entry.uri} ${entry.bytes}B diagnostics=${entry.diagnostics}`;
    case 'edge': {
      const pick = ['method', 'path', 'httpStatus', 'totalDuration', 'responseTime', 'txBytes', 'rxBytes', 'clientUa', 'responseDetails'];
      return `${t} ▸ edge ${pick.map(key => entry[key] ?? entry.attributes?.[key]).filter(value => value !== undefined).join(' ')}`;
    }
    default: return `${t} · ${entry.event}${entry.rpc ? ` ${entry.rpc}` : ''}${entry.name ? ` ${entry.name}` : ''}${entry.code !== undefined ? ` code=${entry.code}` : ''}`;
  }
}

/** What one attempt's window shows. Each finding is an observation in that window, not a claim about the host. */
function findings(window, card) {
  const out = [];
  const reads = window.filter(entry => entry.event === 'mcp.rpc' && entry.rpc === 'resources/read');
  const readEnds = window.filter(entry => entry.event === 'mcp.response' && entry.rpc === 'resources/read');
  if (reads.length === 0) out.push('no card read was observed at the server in this window');
  if (reads.some(entry => entry.uriCurrent === false)) out.push('a card address that is not the one this instance serves was read');
  for (const end of readEnds) if (end.stream !== 'drained') out.push(`a card read stream was ${end.stream} after ${end.ms}ms and ${end.bytes}B`);
  for (const end of readEnds) if (end.errorCode !== undefined) out.push(`a card read answered JSON-RPC error ${end.errorCode}`);
  const slow = readEnds.filter(end => end.ms > 2_000);
  if (slow.length) out.push(`card read streams slower than 2s on this side: ${slow.map(end => `${end.ms}ms`).join(', ')}`);
  const cards = new Map();
  for (const entry of window.filter(item => item.event === 'view.report')) cards.set(entry.view, entry);
  if (card === 'diagnostic') out.push(`${cards.size} card instance(s) reported in this window${cards.size === 0 ? ' (none observed: a card may not have run, or its report did not arrive)' : ''}`);
  for (const [id, last] of cards) {
    const m = last.marks ?? {};
    if (m.main === undefined) out.push(`card ${id}: the bundle had not evaluated by its last report (${last.reason})`);
    if (m.teardownRequested !== undefined && m.ready === undefined) out.push(`card ${id}: the host asked for teardown before the card was ready, as of its last report`);
    if (last.failure) out.push(`card ${id}: start failed (${last.failure})`);
    if (m.ready !== undefined && m.script !== undefined && m.ready - m.script > 3_000) out.push(`card ${id}: ${Math.round(m.ready - m.script)}ms from script start to ready`);
    if (m.hostMessage === undefined) out.push(`card ${id}: no host message observed by its last report (${last.reason})`);
  }
  return out;
}

/** Signs that a window holds traffic other than this trial's, so its records cannot be attributed with confidence. */
function ambiguity(window, trial) {
  const out = [];
  const clients = new Set(window.filter(entry => entry.event === 'mcp.rpc' && entry.client).map(entry => `${entry.client}/${entry.clientVersion}`));
  if (clients.size > 1) out.push(`${clients.size} different MCP clients: ${[...clients].join(', ')}`);
  const overlapping = trials.filter(other => other !== trial && Date.parse(other.start) < Date.parse(trial.end) && Date.parse(other.end) > Date.parse(trial.start));
  if (overlapping.length) out.push(`${overlapping.length} other trial(s) overlap this one`);
  const releases = new Set(window.filter(entry => entry.release).map(entry => entry.release));
  if (trial.release && trial.release !== 'unknown' && releases.size && ![...releases].every(release => release === trial.release)) out.push(`records from releases ${[...releases].join(', ')}, trial recorded ${trial.release}`);
  return out;
}

for (const trial of trials) {
  const start = Date.parse(trial.start);
  const end = Date.parse(trial.end);
  const retryAt = trial.retryAt ? Date.parse(trial.retryAt) : undefined;
  const all = entries.filter(entry => entry.at >= start - LEAD_MS && entry.at <= end);
  const serving = entries.filter(entry => entry.event === 'view.prepared' && entry.at <= end).at(-1);
  console.log(`\n=== ${trial.host} / ${trial.deploy} / ${trial.card ?? '?'} card / ${trial.label}: first=${trial.first} retry=${trial.retry}`);
  console.log(`    release ${trial.release ?? '?'} at ${trial.origin ?? '?'}; serving ${serving ? `${serving.uri} (${serving.bytes}B, diagnostics=${serving.diagnostics})` : 'not observed in these logs'}`);
  for (const warning of ambiguity(all, trial)) console.log(`  ? AMBIGUOUS: ${warning}`);
  const attempts = [['first attempt', start - LEAD_MS, retryAt ?? end]];
  if (retryAt !== undefined) attempts.push(['retry', retryAt, end]);
  for (const [name, from, to] of attempts) {
    const window = entries.filter(entry => entry.at >= from && entry.at < to || (to === end && entry.at === end));
    console.log(`  -- ${name} (${new Date(from).toISOString()} → ${new Date(to).toISOString()})`);
    for (const entry of window) console.log(describe(entry, start));
    for (const finding of findings(window, trial.card)) console.log(`  ! ${finding}`);
  }
}

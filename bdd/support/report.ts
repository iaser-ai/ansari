import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BDD_DIR } from './env.ts';

/**
 * Collects measurements across the run and writes them as one Markdown file,
 * ready to paste into a PR comment.
 */
interface Table {
  title: string;
  note?: string;
  columns: string[];
  rows: string[][];
}

const tables = new Map<string, Table>();
const outcomes: string[][] = [];
const warnings = new Set<string>();

/** Shown at the top of the report: anything that makes this run's numbers unrepresentative. */
export function addWarning(text: string): void {
  if (!warnings.has(text)) console.warn(`\n[bdd] WARNING: ${text}`);
  warnings.add(text);
}

export function addRow(title: string, columns: string[], row: (string | number)[], note?: string): void {
  let table = tables.get(title);
  if (!table) {
    table = { title, note, columns, rows: [] };
    tables.set(title, table);
  }
  table.rows.push(row.map(String));
}

export function addOutcome(feature: string, scenario: string, status: string, detail: string): void {
  outcomes.push([feature, scenario, status, detail.replace(/\s+/g, ' ').slice(0, 160)]);
}

function markdownTable(columns: string[], rows: string[][]): string {
  const esc = (c: string) => c.replace(/\|/g, '\\|');
  return [
    `| ${columns.map(esc).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function writeReport(): string | null {
  if (outcomes.length === 0 && tables.size === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BDD_DIR, 'results', `run-${stamp}.md`);
  const parts = [`# Image attachments: local BDD run (${new Date().toISOString()})`, ''];
  for (const w of warnings) parts.push(`> **Warning:** ${w}`, '');
  if (outcomes.length > 0) {
    parts.push('## Scenarios', '', markdownTable(['Feature', 'Scenario', 'Result', 'Detail'], outcomes), '');
  }
  for (const t of tables.values()) {
    parts.push(`## ${t.title}`, '');
    if (t.note) parts.push(t.note, '');
    parts.push(markdownTable(t.columns, t.rows), '');
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, parts.join('\n'));
  return file;
}

export const fmt = {
  usd: (n: number) => `$${n.toFixed(4)}`,
  sec: (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`),
  mb: (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`,
  pct: (x: number) => `${(x * 100).toFixed(1)}%`,
};

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

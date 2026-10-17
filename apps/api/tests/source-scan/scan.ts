// Source scans for spec 300 (plan phase 9): the legacy auth model is gone from
// runtime code and stays gone. The scanner reads code through the TypeScript
// parser, so comments never count: a column named in a comment is not a query.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

/** Every source file under `dir` (repo-relative), skipping build output and dependencies. */
export function sourceFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  return readdirSync(abs).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.next')) return [];
    const rel = path.join(dir, name);
    if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return SOURCE_FILE.test(name) ? [rel] : [];
  });
}

export function readSource(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/**
 * The text of every string and template literal, templates with their `${…}`
 * placeholders as written (so `sql\`SELECT * FROM ${users}\`` reads as such).
 */
export function literalTexts(source: string): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      texts.push(node.getText());
      if (ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return texts;
}

/** The code with every comment removed: identifiers, literals and punctuation only. */
export function codeWithoutComments(source: string): string {
  return ts.createPrinter({ removeComments: true }).printFile(parse(source));
}

// ── Scan 1: no legacy auth column, no `tokens` table, no SELECT * on users ──

const LEGACY_COLUMN = /\b(password_hash|is_admin|session_version)\b/i;
const TOKENS_TABLE = /\b(?:from|join|into|update|table|truncate)\s+(?:"?public"?\s*\.\s*)?"?tokens"?(?![\w"])/i;
const SELECT_STAR_USERS =
  /\bselect\s+(?:"?\w+"?\s*\.\s*)?\*\s+from\s+(?:\$\{\s*users\s*\}|(?:"?public"?\s*\.\s*)?"?users"?(?![\w"]))/i;

/** Raw-SQL hits in one file's literals: legacy columns, the `tokens` table, `SELECT *` on users. */
export function legacySqlHits(source: string): string[] {
  return literalTexts(source).filter(
    (text) => LEGACY_COLUMN.test(text) || TOKENS_TABLE.test(text) || SELECT_STAR_USERS.test(text)
  );
}

// ── Scan 2: one DATABASE_URL per service, no literal connection string ──

const SPLIT_DB_URL = /\b(?:APP|AUTH)_DATABASE_URL\b/;
const POSTGRES_URL = /postgres(?:ql)?:\/\//i;

/** Hits in one file: a named APP_/AUTH_DATABASE_URL in code, or a literal postgres:// URL. */
export function databaseUrlHits(source: string): string[] {
  const hits: string[] = [];
  const code = codeWithoutComments(source);
  const named = code.match(new RegExp(SPLIT_DB_URL.source, 'g'));
  if (named) hits.push(...named);
  hits.push(...literalTexts(source).filter((text) => POSTGRES_URL.test(text)));
  return hits;
}

/**
 * The cutover scripts are the one place both databases are named (the copy
 * reads one and writes the other), so they are excluded, by path, and only them.
 */
export const CUTOVER_SCRIPTS_DIR = 'apps/auth/scripts/cutover/';

export function isExcludedFromDatabaseUrlScan(rel: string): boolean {
  return rel.split(path.sep).join('/').startsWith(CUTOVER_SCRIPTS_DIR);
}

// ── Scan 3: apps/api never imports or depends on better-auth or @ansari/auth ──

const AUTH_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](?:better-auth|@better-auth\/[^'"]+|@ansari\/auth)(?:\/[^'"]*)?['"]/;
const AUTH_PACKAGE = /^(?:better-auth|@better-auth\/.+|@ansari\/auth)$/;

/** Import hits in one file (comments excluded). */
export function authImportHits(source: string): string[] {
  const code = codeWithoutComments(source);
  const match = code.match(new RegExp(AUTH_IMPORT.source, 'g'));
  return match ?? [];
}

/** Dependency hits in a package.json's dependency maps. */
export function authDependencyHits(pkg: Record<string, unknown>): string[] {
  const maps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  return maps.flatMap((key) =>
    Object.keys((pkg[key] as Record<string, string> | undefined) ?? {}).filter((name) => AUTH_PACKAGE.test(name))
  );
}

// ── Scan 4: the removed internal hop stays gone (owner amendment 2026-10-17) ──

/**
 * The names the shared-secret hop used: its env vars, its headers and their
 * constants, the internal port and rate-limit mode, Railway's private-network
 * host, and the /internal routes.
 */
const REMOVED_HOP: readonly RegExp[] = [
  /\bAUTH_INTERNAL_(?:SECRET|URL)\b/,
  /\bINTERNAL_PORT\b/,
  /\bAUTH_RATE_LIMIT_MODE\b/,
  // apps/auth's admin list (H-7). apps/api's legacy variable of the same name
  // lives only on the backend service until the contract PR, never in code.
  /\bADMIN_EMAILS\b/,
  /\bINTERNAL_AUTH_HEADER\b/,
  /\bFORWARDED_IP_HEADER\b/,
  /x-ansari-internal-auth/i,
  /x-ansari-forwarded-client-ip/i,
  // The removed internal listener on Railway's private network. The cutover scripts name
  // `<name>.railway.internal` database hosts (H-8): those are not the hop.
  /\.railway\.internal:3101\b/i,
  /['"`]\/internal(?:\/|['"`])/,
];

/** Hits in code (comments stripped): any name of the removed internal hop. */
export function removedHopHits(source: string): string[] {
  return removedHopTextHits(codeWithoutComments(source));
}

/** The same patterns over plain text, comments included (config files, Dockerfiles). */
export function removedHopTextHits(text: string): string[] {
  return text.split('\n').filter((line) => REMOVED_HOP.some((re) => re.test(line)));
}

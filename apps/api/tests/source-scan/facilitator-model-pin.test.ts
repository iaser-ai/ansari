// Source scan for issue #393. `runFacilitator` takes a `model` option that pins a request
// to one Gemini model with cross-model failover and Inkling escalation switched off. It
// exists for the evaluation harness (apps/eval) only. A route that passed it would
// take a user's request out of the production failover path, so no route may.
//
// The scan reads code through the TypeScript parser (comments and strings never count),
// is proven on planted lines and near-misses before it is trusted on the tree, and
// asserts a floor on what it walked, so an empty walk or a renamed function cannot pass.
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readSource, sourceFiles } from './scan';

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Every name `runFacilitator` goes by in a file: itself, and any `import { runFacilitator as x }`. */
function facilitatorNames(file: ts.SourceFile): Set<string> {
  const names = new Set(['runFacilitator']);
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName?.text === 'runFacilitator') names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
      ? name.expression.text
      : null;

export interface FacilitatorCallScan {
  /** How many `runFacilitator(...)` calls the file makes. */
  calls: number;
  /** Why a call is refused, one entry per offending call. */
  hits: string[];
}

/**
 * Calls of `runFacilitator` whose options could carry `model`. The rule is strict so that
 * it fails loudly: the third argument must be absent, or an object literal written at the
 * call, with no `model` key, no spread and no key the scan cannot read. Options built
 * elsewhere (a variable, a spread) are refused, because the scan cannot see inside them.
 */
export function facilitatorModelHits(source: string): FacilitatorCallScan {
  const file = parse(source);
  const names = facilitatorNames(file);
  const out: FacilitatorCallScan = { calls: 0, hits: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (called !== null && names.has(called)) {
        out.calls++;
        const options = node.arguments[2];
        const text = node.getText(file).replace(/\s+/g, ' ').slice(0, 120);
        if (node.arguments.some((a) => ts.isSpreadElement(a))) {
          out.hits.push(`spread arguments: ${text}`);
        } else if (options !== undefined) {
          if (!ts.isObjectLiteralExpression(options)) {
            out.hits.push(`options are not written at the call: ${text}`);
          } else {
            for (const property of options.properties) {
              if (ts.isSpreadAssignment(property)) {
                out.hits.push(`options spread another object: ${text}`);
                continue;
              }
              const key = property.name ? propertyName(property.name) : null;
              if (key === null) out.hits.push(`an option key the scan cannot read: ${text}`);
              else if (key === 'model') out.hits.push(`passes \`model\`: ${text}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * Import or require specifiers that reach into the evaluation harness: a path with an
 * `eval` directory in it (apps/eval is `../../eval` from apps/api/lib), or the harness's
 * package name, `ansari-eval`.
 */
export function evalImportHits(source: string): string[] {
  const hits: string[] = [];
  const inEval = (specifier: string) => /(^|\/)(ansari-)?eval(\/|$)/.test(specifier);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (inEval(node.moduleSpecifier.text)) hits.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      inEval(node.arguments[0].text)
    ) {
      hits.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return hits;
}

/** A file of the harness, where it lives since issue #397. */
const HARNESS_FILE = 'apps/eval/lib/score.ts';

/** Would this Docker COPY source or deploy watch pattern take in a file of the harness? */
export function reachesHarness(pattern: string): boolean {
  const glob = pattern.replace(/^(\.?\/)+/, '').replace(/\/+$/, '');
  if (glob === '' || glob === '.') return true;
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${body}(/.*)?$`).test(HARNESS_FILE);
}

const IMPORT = "import { runFacilitator } from '@/lib/facilitator/agent';\n";

describe('no route pins a request to a model (issue #393)', () => {
  it('catches planted lines', () => {
    for (const bad of [
      "for await (const e of runFacilitator(history, undefined, { model: 'gemini-4-argon' })) {}",
      'runFacilitator(history, undefined, { model });',
      'runFacilitator(history, onMessage, { provider, model: body.model });',
      "runFacilitator(history, undefined, { 'model': chosen });",
      "runFacilitator(history, undefined, { ['model']: chosen });",
      // Options the scan cannot see inside are refused too.
      'runFacilitator(history, undefined, { ...requestOptions });',
      'runFacilitator(history, undefined, options);',
      'runFacilitator(history, undefined, { [key]: value });',
      'runFacilitator(...args);',
      // Called through a namespace, and under another name.
      "facilitator.runFacilitator(history, undefined, { model: 'x' });",
    ]) {
      const scan = facilitatorModelHits(IMPORT + bad);
      expect(scan.calls, bad).toBe(1);
      expect(scan.hits, bad).toHaveLength(1);
    }
    const aliased = "import { runFacilitator as run } from '@/lib/facilitator/agent';\nrun(history, undefined, { model: 'x' });";
    expect(facilitatorModelHits(aliased)).toMatchObject({ calls: 1, hits: [expect.stringContaining('passes `model`')] });
  });

  it('passes near-misses', () => {
    for (const fine of [
      // The calls the routes make today.
      'for await (const event of runFacilitator(messageHistory)) {}',
      'for await (const event of runFacilitator(messages, undefined, { provider })) {}',
      "runFacilitator(messages, onMessage, { provider: 'inkling' });",
      // `model` somewhere else: another function's options, another key, a variable.
      "streamGemini(contents, { model: 'gemini-3.7-flash' }); runFacilitator(messages);",
      'const model = config.gemini.model; runFacilitator(messages, undefined, { provider });',
      'runFacilitator(messages, undefined, { modelFamily, provider });',
      // In a comment or a string, it is not code.
      "// runFacilitator(history, undefined, { model: 'x' })\nrunFacilitator(history);",
      'const doc = "runFacilitator(history, undefined, { model })"; runFacilitator(history);',
    ]) {
      const scan = facilitatorModelHits(IMPORT + fine);
      expect(scan.calls, fine).toBe(1);
      expect(scan.hits, fine).toEqual([]);
    }
    // A file that never calls it has nothing to report.
    expect(facilitatorModelHits('export const model = 1;')).toEqual({ calls: 0, hits: [] });
  });

  it('holds on apps/api/src: every runFacilitator call is found, and none can carry `model`', () => {
    const files = sourceFiles('apps/api/src');
    const routes = files.filter((f) => f.split('\\').join('/').startsWith('apps/api/src/app/api/'));
    let calls = 0;
    const hits: Record<string, string[]> = {};
    for (const file of files) {
      const scan = facilitatorModelHits(readSource(file));
      calls += scan.calls;
      if (scan.hits.length > 0) hits[file] = scan.hits;
    }
    console.info(
      `[source-scan] facilitator model pin: ${Object.values(hits).flat().length} hits, ${calls} runFacilitator calls, ${files.length} files (${routes.length} under src/app/api)`,
    );
    // Floors: the walk reached the routes, and the scan recognised the calls they make
    // (chat, thread, mcp-complete and the OpenAI-compatible route). If runFacilitator is
    // renamed or wrapped, this fails rather than passing on zero calls.
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(hits).toEqual({});
  });
});

describe('the app does not import the evaluation harness (issues #393, #397)', () => {
  it('catches planted lines', () => {
    for (const bad of [
      // By path. The harness is apps/eval: `../../eval` from apps/api/lib or db, deeper from src.
      "import { scoreRun } from '../../eval/lib/score';",
      "import { scoreRun } from '@/eval/lib/score';",
      "export { runJobs } from '../eval/lib/runner';",
      "const { scoreRun } = await import('../../../eval/lib/score');",
      "const prices = require('../../eval/models.json');",
      "import { scoreRun } from '../../../../apps/eval/lib/score';",
      // By package name.
      "import { scoreRun } from 'ansari-eval/lib/score';",
      "const harness = await import('ansari-eval');",
    ]) {
      expect(evalImportHits(bad), bad).toHaveLength(1);
    }
  });

  it('passes near-misses', () => {
    for (const fine of [
      "import { evaluate } from '@/lib/evaluation/rules';",
      "import { retrieval } from './retrieval';",
      "import medieval from 'medieval-names';",
      "import { rules } from 'ansari-evaluation';",
      "import { rules } from '@/lib/ansari-evals/rules';",
      "// import { scoreRun } from '../../eval/lib/score';",
      "const path = '../../eval/lib/score';",
    ]) {
      expect(evalImportHits(fine), fine).toEqual([]);
    }
  });

  it('holds on apps/api/src, lib and db', () => {
    const files = [...sourceFiles('apps/api/src'), ...sourceFiles('apps/api/lib'), ...sourceFiles('apps/api/db')];
    const hits: Record<string, string[]> = {};
    for (const file of files) {
      const found = evalImportHits(readSource(file));
      if (found.length > 0) hits[file] = found;
    }
    console.info(`[source-scan] eval imports: ${Object.values(hits).flat().length} hits in ${files.length} files`);
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(hits).toEqual({});
  });

  // Issue #397: the harness left apps/api so that it is not in the api image
  // (`COPY apps/api apps/api`) and an eval-only edit does not redeploy the api
  // (watch pattern `apps/api/**`). The Dockerfile decides the first. For the second,
  // railway.toml is the reviewable record; the live patterns are in the Railway dashboard.
  it('tells a COPY source or watch pattern that takes in the harness from one that does not', () => {
    for (const bad of ['.', './', 'apps', './apps/', 'apps/eval', 'apps/eval/', 'apps/**', 'apps/*', '**', 'apps/eval/lib/*.ts']) {
      expect(reachesHarness(bad), bad).toBe(true);
    }
    for (const fine of ['apps/api', 'apps/api/**', 'apps/api/package.json', 'packages', 'packages/**', 'package.json', 'apps/evaluation/**', 'eval/**']) {
      expect(reachesHarness(fine), fine).toBe(false);
    }
  });

  it('is outside what the api image copies and what the api deploy watches', () => {
    expect(existsSync(path.join(REPO_ROOT, 'apps/api/eval'))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, HARNESS_FILE))).toBe(true);
    const manifest = JSON.parse(readSource('apps/api/package.json')) as Record<string, Record<string, string> | undefined>;
    expect({ ...manifest.dependencies, ...manifest.devDependencies }).not.toHaveProperty('ansari-eval');

    // The COPY reader takes one line per instruction. A continued or heredoc COPY
    // would be read in part, so it is refused rather than half-checked.
    const dockerfile = readSource('apps/api/Dockerfile');
    expect(dockerfile).not.toMatch(/^COPY\b.*(\\|<<)/m);
    const copied = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1));
    const watchList = readSource('apps/api/railway.toml').match(/^watchPatterns = \[([\s\S]*?)^\]/m);
    const watched = [...(watchList?.[1] ?? '').matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
    const reaching = [...copied, ...watched].filter(reachesHarness);
    console.info(`[source-scan] api image: ${reaching.length} of ${copied.length} COPY sources and ${watched.length} watch patterns take in apps/eval`);
    // Floors: both lists were read, and each still names the app itself.
    expect(copied).toContain('apps/api');
    expect(watched).toContain('apps/api/**');
    expect(reaching).toEqual([]);
  });
});

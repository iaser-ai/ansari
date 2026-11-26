// Source scan for issue #400. The thread history limit is applied by the routes, not
// inside `runFacilitator` (lib/facilitator/history-limit.ts says why), so a route that
// called the facilitator without it would send an unbounded history to the model again.
// Every `runFacilitator(...)` call under apps/api/src must therefore be covered, one of
// two ways:
//   - it is made inside a `limitThreadTurn(...)` call (the thread routes: warn and block
//     arrive as part of the answer), or
//   - its file also calls `assessHistory(...)` (the stateless routes: 400 on block).
//
// The scan reads code through the TypeScript parser (comments and strings never count),
// is proven on planted lines and near-misses before it is trusted on the tree, and
// asserts floors on what it walked, so an empty walk or a renamed function cannot pass.
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readSource, sourceFiles } from './scan';

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const AGENT_FUNCTION = 'runFacilitator';
const LIMIT_FUNCTIONS = ['limitThreadTurn', 'assessHistory'] as const;
type LimitFunction = (typeof LIMIT_FUNCTIONS)[number];

/** Every name the three functions go by in a file: themselves, and any `import { x as y }`. */
function localNames(file: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>([AGENT_FUNCTION, ...LIMIT_FUNCTIONS].map((name) => [name, name]));
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName && names.has(node.propertyName.text)) {
      names.set(node.name.text, node.propertyName.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

export interface HistoryLimitScan {
  /** `runFacilitator(...)` calls made inside a `limitThreadTurn(...)` call. */
  wrapped: number;
  /** `runFacilitator(...)` calls outside one, in a file that calls `assessHistory(...)`. */
  assessed: number;
  /** `runFacilitator(...)` calls with neither: one entry per offending call. */
  uncovered: string[];
}

export function historyLimitScan(source: string): HistoryLimitScan {
  const file = parse(source);
  const names = localNames(file);
  const calledName = (node: ts.CallExpression): string | undefined => {
    const callee = node.expression;
    const text = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    return text === null ? undefined : names.get(text);
  };

  const bare: string[] = [];
  let wrapped = 0;
  let assesses = false;
  const visit = (node: ts.Node, insideLimit: boolean): void => {
    if (ts.isCallExpression(node)) {
      const called = calledName(node);
      if (called === AGENT_FUNCTION) {
        if (insideLimit) wrapped++;
        else bare.push(node.getText(file).replace(/\s+/g, ' ').slice(0, 120));
      } else if ((called as LimitFunction) === 'assessHistory') {
        assesses = true;
      } else if ((called as LimitFunction) === 'limitThreadTurn') {
        // Only the arguments are inside it: `limitThreadTurn(...)(runFacilitator())` is not.
        visit(node.expression, insideLimit);
        for (const argument of node.arguments) visit(argument, true);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, insideLimit));
  };
  visit(file, false);

  return assesses
    ? { wrapped, assessed: bare.length, uncovered: [] }
    : { wrapped, assessed: 0, uncovered: bare };
}

const IMPORTS =
  "import { runFacilitator } from '@/lib/facilitator/agent';\n" +
  "import { assessHistory, limitThreadTurn } from '@/lib/facilitator/history-limit';\n";

describe('every route that runs the facilitator applies the thread history limit (issue #400)', () => {
  it('catches planted lines', () => {
    for (const bad of [
      // The thread routes as they were before the limit.
      'for await (const event of runFacilitator(messageHistory)) {}',
      'for await (const event of runFacilitator(messages, undefined, { provider })) {}',
      // The limit named but not applied: imported only, in a comment, in a string.
      '// assessHistory(messages)\nrunFacilitator(messages);',
      'const doc = "limitThreadTurn(messages, id, () => runFacilitator(messages))"; runFacilitator(messages);',
      // The wrapper called beside the facilitator rather than around it.
      'limitThreadTurn(messages, threadId, () => other()); for await (const e of runFacilitator(messages)) {}',
      'limitThreadTurn(messages, threadId, run)(runFacilitator(messages));',
      // Through a namespace.
      'for await (const e of facilitator.runFacilitator(messages)) {}',
    ]) {
      const scan = historyLimitScan(IMPORTS + bad);
      expect(scan.uncovered, bad).toHaveLength(1);
      expect(scan.wrapped + scan.assessed, bad).toBe(0);
    }
    const aliased = "import { runFacilitator as run } from '@/lib/facilitator/agent';\nfor await (const e of run(messages)) {}";
    expect(historyLimitScan(aliased).uncovered).toHaveLength(1);
  });

  it('passes the covered forms', () => {
    for (const fine of [
      // The thread routes.
      'const turn = limitThreadTurn(messageHistory, threadId, () => runFacilitator(messageHistory));',
      'for await (const e of limitThreadTurn(messages, id, function () { return runFacilitator(messages); })) {}',
    ]) {
      expect(historyLimitScan(IMPORTS + fine), fine).toEqual({ wrapped: 1, assessed: 0, uncovered: [] });
    }
    for (const fine of [
      // The stateless routes: the verdict is checked, then the facilitator runs.
      "if (assessHistory(messages).verdict === 'block') return refuse(); for await (const e of runFacilitator(messages)) {}",
      'const history = assessHistory(messages); runFacilitator(messages, undefined, { provider });',
    ]) {
      expect(historyLimitScan(IMPORTS + fine), fine).toEqual({ wrapped: 0, assessed: 1, uncovered: [] });
    }
    const aliased =
      "import { runFacilitator as run } from '@/lib/facilitator/agent';\n" +
      "import { limitThreadTurn as limit } from '@/lib/facilitator/history-limit';\n" +
      'limit(messages, id, () => run(messages));';
    expect(historyLimitScan(aliased)).toEqual({ wrapped: 1, assessed: 0, uncovered: [] });
    // A file that never runs the facilitator has nothing to cover.
    expect(historyLimitScan('export const limitThreadTurn = 1;')).toEqual({ wrapped: 0, assessed: 0, uncovered: [] });
  });

  it('holds on apps/api/src: every runFacilitator call is covered', () => {
    const files = sourceFiles('apps/api/src');
    const uncovered: Record<string, string[]> = {};
    const wrappedIn: string[] = [];
    const assessedIn: string[] = [];
    for (const file of files) {
      const scan = historyLimitScan(readSource(file));
      const posix = file.split('\\').join('/');
      if (scan.uncovered.length > 0) uncovered[posix] = scan.uncovered;
      if (scan.wrapped > 0) wrappedIn.push(posix);
      if (scan.assessed > 0) assessedIn.push(posix);
    }
    console.info(
      `[source-scan] history limit: ${Object.values(uncovered).flat().length} uncovered, ` +
        `${wrappedIn.length} files wrapped, ${assessedIn.length} files assessed, ${files.length} files`,
    );
    // Floors: the scan recognised the calls the four routes make. If runFacilitator or
    // the limit is renamed or moved, this fails rather than passing on zero calls.
    expect(wrappedIn.sort()).toEqual([
      'apps/api/src/app/api/v2/threads/[id]/chat/route.ts',
      'apps/api/src/app/api/v2/threads/[id]/route.ts',
    ]);
    expect(assessedIn.sort()).toEqual([
      'apps/api/src/app/api/v1/chat/completions/route.ts',
      'apps/api/src/app/api/v2/chat/complete/route.ts',
      'apps/api/src/app/api/v2/mcp-complete/route.ts',
    ]);
    expect(uncovered).toEqual({});
  });
});

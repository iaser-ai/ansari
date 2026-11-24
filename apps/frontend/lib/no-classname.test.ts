import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Uniwind is installed but NOT wired into Metro (#428: its react-native shim
// lacks RN 0.88's AssetRegistry; see metro.config.js). tsconfig still includes
// uniwind-env.d.ts, so `<View className="…">` typechecks, and with the wrapper
// unwired it silently does nothing on every platform. This scan keeps
// `className` out of the UI until Uniwind is re-wired (#264): remove it then.

const root = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['app', 'components'];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** `file:line` of every JSX `className` attribute (comments and strings never match). */
function classNameSites(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className') {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      sites.push(`${path.relative(root, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('no className while Uniwind is unwired (#428)', () => {
  const files = SCANNED_DIRS.flatMap((dir) => walk(path.join(root, dir)));

  it('scans the UI sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('app/ and components/ set no className', () => {
    const sites = files.flatMap((file) => classNameSites(file, readFileSync(file, 'utf8')));
    expect(sites).toEqual([]);
  });

  it('the scan flags a planted className', () => {
    const planted = 'export const A = () => <View className="flex-1" style={s} />;';
    expect(classNameSites(path.join(root, 'components', 'Planted.tsx'), planted)).toEqual([
      'components/Planted.tsx:1',
    ]);
  });

  it('the scan ignores near-misses: comments, strings and other props', () => {
    const nearMiss = [
      '// <View className="x" /> in a comment',
      'const doc = \'<View className="x" />\';',
      'export const B = () => <Thing classNames="x" containerClassName="y" />;',
    ].join('\n');
    expect(classNameSites(path.join(root, 'components', 'NearMiss.tsx'), nearMiss)).toEqual([]);
  });
});

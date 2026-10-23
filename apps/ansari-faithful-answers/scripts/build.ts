import {readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build as viteBuild} from 'vite';
import {build as esbuild} from 'esbuild';
import {viteSingleFile} from 'vite-plugin-singlefile';
import {createContentPolicy, embedContentPolicy} from '@saga-a2ui/react-mcp-stack/content-policy';
import {APP_VERSION} from '../src/version.js';
import {BRANDING} from '../src/view/branding.js';

// `tsx scripts/build.ts [node|worker]`: both targets build the same card; each then bundles its own entry.
const target = process.argv[2] ?? 'node';
if (target !== 'node' && target !== 'worker') throw new Error(`unknown build target: ${target} (node or worker)`);

const root = fileURLToPath(new URL('../', import.meta.url));
// The SDK identity (the pinned public registry release) the card document carries beside the application release,
// read by the same script the tests use.
const sdk = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/sdk-identity.mjs')], {encoding: 'utf8'})) as Record<'kind' | 'version' | 'source' | 'stackSha256' | 'setSha256', string>;
const SDK_FIELD = /^[A-Za-z0-9._+-]{1,80}$/;
for (const [field, value] of Object.entries(sdk)) if (!SDK_FIELD.test(value)) throw new Error(`The SDK identity ${field} is not a plain token: ${value}`);
const dist = path.join(root, 'dist');
// The Node artifact is the whole of dist/. A Workers build adds only the card, so it leaves a Node artifact intact.
if (target === 'node') rmSync(dist, {recursive: true, force: true});
mkdirSync(dist, {recursive: true});
await viteBuild({
  configFile: false,
  root: path.join(root, 'src/view'),
  base: './',
  plugins: [viteSingleFile(), {
    name: 'ansari-brand',
    transformIndexHtml: html => html.replaceAll('{{brand.name}}', BRANDING.name).replaceAll('{{release}}', APP_VERSION)
      .replaceAll('{{sdk.kind}}', sdk.kind).replaceAll('{{sdk.version}}', sdk.version).replaceAll('{{sdk.source}}', sdk.source)
      .replaceAll('{{sdk.stackSha256}}', sdk.stackSha256).replaceAll('{{sdk.setSha256}}', sdk.setSha256),
  }],
  esbuild: {jsx: 'automatic'},
  build: {
    outDir: dist, emptyOutDir: false, target: 'es2022', cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {input: path.join(root, 'src/view/mcp-app-react.html')},
  },
});
// The application's one policy: Standard, no external image origin, no font origin. A constant, never derived from data.
const policy = createContentPolicy({level: 'standard', imageHosts: [], fontOrigins: []});
if (!policy.ok) throw new Error(policy.failure.message);
const built = path.join(dist, 'mcp-app-react.html');
writeFileSync(path.join(dist, 'view.html'), embedContentPolicy(readFileSync(built, 'utf8'), policy.policy));
rmSync(built);
if (target === 'node') {
  await esbuild({
    absWorkingDir: root, entryPoints: ['src/node/index.ts'], outfile: 'dist/server/index.js',
    bundle: true, platform: 'node', target: 'node22', format: 'esm',
    banner: {js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"},
  });
} else {
  // Wrangler's own bundling, without publishing: the entry imports dist/view.html as text, so the card is part of the bundle.
  // wrangler.jsonc has no top-level Worker, so the dry run names an environment to find the entry point. The bundle holds no
  // environment setting (vars and secrets are bindings applied at deploy time), so the same bundle serves every environment.
  const outdir = path.join(root, 'dist-worker');
  rmSync(outdir, {recursive: true, force: true});
  execFileSync(path.join(root, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--env', 'dev', '--outdir', outdir], {cwd: root, stdio: 'inherit'});
}

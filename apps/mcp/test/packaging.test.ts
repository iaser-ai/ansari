import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('packaged HTML is self-contained and assets contain bytes',()=>{
  const html=readFileSync(join(root,'dist/view.html'),'utf8');
  assert.ok(html.includes('data:image/'));
  for (const name of ['Kitab-Regular.ttf', 'Kitab-Bold.ttf']) {
    const bytes=readFileSync(join(root,'assets/fonts',name));
    assert.equal(bytes.readUInt32BE(0),0x00010000, 'actual TrueType bytes');
    assert.ok(html.includes(bytes.toString('base64')), `${name} is embedded verbatim`);
  }
  assert.ok(!html.includes('version https://git-lfs.github.com/spec/v1'));
  assert.doesNotMatch(html,/<script[^>]+src=/i);
  assert.doesNotMatch(html,/<link[^>]+href=["'][^"']+\.css/i);
  assert.doesNotMatch(html,/\{\{brand\.|\{\{release\}\}|\{\{sdk\./);
  assert.deepEqual(readdirSync(join(root,'dist')).sort(),['server','view.html']);
  for(const name of ['answer-assets.ts','brand-mark.ts']) {
    const source=readFileSync(join(root,'assets',name),'utf8');
    assert.ok(!source.startsWith('version https://git-lfs.github.com/spec/v1'));
  }
});

// ---- The SAGA packages: exact public npm releases, never a tag, range, tarball or local file.
// SAGA versions its packages independently: the stack pins each sibling to one exact version, which need not be its own.
// The versions and integrity below were read from the public npm registry (`npm view @saga-a2ui/react-mcp-stack@1.0.1
// dependencies`, then `npm view @saga-a2ui/<name>@<version> dist.integrity`), not from the files they are compared with.
const SDK_VERSION='1.0.1';
const SDK_PACKAGES:Record<string,{version:string;integrity:string}>={
  core:{version:'1.0.0',integrity:'sha512-vrL4nuxLzFWs98vJKp1P5v3eVFxPAgyu7b17TkHaYqIIAwWDjAN7ZRdyABk5a8MKG7NIWyPFiqLEK04mfn62rA=='},
  components:{version:'1.0.0',integrity:'sha512-SLNlcsw6IrRSd087fTp2uGgBHoqdpUnE+o3G3OZvmRqdRCPZhfjO45mofSGnH2VsrpUQjHTtWSUv0X1NPPHq5g=='},
  mcp:{version:'1.0.2',integrity:'sha512-gbskrVWOXLnrkS6tSl5FUQMSvx/lankpzQGJFMg/9nHMBup+BoV5kkdjdKyzrHMlrzD5WmpEXIZtAJ403r+hPQ=='},
  react:{version:'1.0.0',integrity:'sha512-Pay/Mz2yNcnsoDLkJo8twFEYUoIx3te6n/w/FOo2jfuSrVh7A0HSS7UVEFuo/oT6pkouwJoEZPO5Sqf6NUojOw=='},
  'react-mcp-stack':{version:SDK_VERSION,integrity:'sha512-5uu8h9NAZGs9sfvjmFKfxQzWMTpm/0DjKrb5x1TtlyDRkiRCUSuD2qmxQVFI7f5/TIMymc4XYxGAROwacx/XNg=='},
};
const SIBLINGS=Object.keys(SDK_PACKAGES);
const ref=(sibling:string)=>`@saga-a2ui/${sibling}@${SDK_PACKAGES[sibling].version}`;
const node=(...args:string[])=>execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'});

test('the manifest pins one exact public version for every SAGA package it imports',()=>{
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const saga=Object.entries<string>({...manifest.dependencies,...manifest.devDependencies}).filter(([name])=>name.startsWith('@saga-a2ui/'));
  assert.deepEqual(saga.map(([name])=>name).sort(),['@saga-a2ui/react-mcp-stack']);
  for(const [name,version] of saga) {
    assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,`${name} is an exact version, never a tag or range`);
    assert.equal(version,SDK_VERSION,name);
  }
  assert.equal(manifest.devDependencies.typescript, 'catalog:');
  assert.equal(manifest.devDependencies.eslint, 'catalog:');
  assert.equal(manifest.devDependencies['@ansari/eslint-config'], 'workspace:*');
  assert.ok(!/"(?:file|link|workspace|git\+?[a-z]*|https?):/.test(JSON.stringify({...manifest.dependencies,overrides:manifest.overrides,pnpm:manifest.pnpm})),'no local, tarball or workspace dependency source');
});

// The lockfile that installs this application: the workspace root's. The application has none of its own (asserted below).
const lockfiles:Array<{label:string;text:string;prefix:string}>=[];
assert.equal(existsSync(join(root,'pnpm-lock.yaml')), false, 'only the root lockfile installs the app');
assert.equal(existsSync(join(root,'pnpm-workspace.yaml')), false, 'only the root workspace config applies');
const workspaceLock=join(root,'../../pnpm-lock.yaml');
if(existsSync(workspaceLock)&&existsSync(join(root,'../../pnpm-workspace.yaml'))) lockfiles.push({label:'workspace root',text:readFileSync(workspaceLock,'utf8'),prefix:'apps/mcp'});

test('every lockfile resolves the five SAGA packages to the public registry with the registry integrity',()=>{
  assert.ok(lockfiles.length>0,'at least one lockfile installs this application');
  for(const {label,text} of lockfiles) {
    for(const sibling of SIBLINGS) {
      const key=`'${ref(sibling)}':\n    resolution: {integrity: ${SDK_PACKAGES[sibling].integrity}}`;
      assert.ok(text.includes(key),`${label} lockfile locks ${sibling} to the registry release with its integrity`);
    }
    // Nothing else from @saga-a2ui, no second SAGA version, and no local source of any kind for it.
    const resolved=[...new Set([...text.matchAll(/^ {2}'(@saga-a2ui\/[a-z-]+)@([^'(]+)':$/gm)].map(match=>`${match[1]}@${match[2]}`))].sort();
    assert.deepEqual(resolved,SIBLINGS.map(ref).sort(),`${label} lockfile: exactly the five packages, each at the version the stack pins`);
    assert.doesNotMatch(text,/@saga-a2ui\/[a-z-]+@file:|tarball: file:|@saga-a2ui\/lit/,`${label} lockfile: no local file or Lit package`);
    assert.doesNotMatch(text,/(?:\/tmp\/|\/opt\/|\/Users\/|\/home\/|[A-Za-z]:\\)/,`${label} lockfile records no machine path`);
  }
});

test('no workspace file overrides a SAGA package',()=>{
  const files=[join(root,'pnpm-workspace.yaml'),join(root,'../../pnpm-workspace.yaml')].filter(file=>existsSync(file));
  assert.ok(files.length>0);
  for(const file of files) {
    const workspace=readFileSync(file,'utf8');
    assert.doesNotMatch(workspace,/@saga-a2ui/,`${file} does not override or mention a SAGA package`);
    assert.doesNotMatch(workspace,/file:|link:/,`${file} has no local-file dependency source`);
    assert.match(workspace,/['"]@a2ui\/react@0\.13\.0>@a2ui\/markdown-it['"]\s*:\s*['"]0\.2\.1['"]/,`${file} pins the A2UI Markdown adapter`);
  }
  assert.equal(existsSync(join(root,'candidates')),false,'no local SAGA inputs are committed');
});

test('the installed siblings are the versions the stack pins, with one framework runtime',()=>{
  const modules=join(root,'node_modules');
  const scope=dirname(realpathSync(join(modules,'@saga-a2ui/react-mcp-stack')));
  for(const sibling of SIBLINGS) {
    const installed=JSON.parse(readFileSync(join(scope,sibling,'package.json'),'utf8'));
    assert.equal(installed.name,`@saga-a2ui/${sibling}`);
    assert.equal(installed.version,SDK_PACKAGES[sibling].version,`${sibling} is the version the stack pins`);
    // Every SDK sibling it depends on or needs as a peer is pinned to exactly the installed version of that sibling.
    for(const field of ['dependencies','peerDependencies']) for(const [dependency,range] of Object.entries<string>(installed[field]??{})) if(dependency.startsWith('@saga-a2ui/')) assert.equal(range,SDK_PACKAGES[dependency.slice('@saga-a2ui/'.length)]?.version,`${sibling} ${field} ${dependency}`);
  }
  // Only those five are installed.
  assert.deepEqual(readdirSync(scope).sort(),SIBLINGS.slice().sort());
  assert.ok(!readdirSync(join(scope,'..','..')).some(name=>/^@saga-a2ui\+lit/.test(name)),'no Lit package in the installed store');
  // The stack declares the components package and its Markdown parser, so the installed tree has both
  // (the emitted browser bundle is a separate question, answered by the card application using them).
  assert.ok(existsSync(join(realpathSync(join(scope,'components')),'../../markdown-it')),'markdown-it is installed beside the components package');
  for(const runtime of ['react','react-dom']) {
    const one=realpathSync(join(modules,runtime));
    assert.equal(JSON.parse(readFileSync(join(one,'package.json'),'utf8')).version,'19.3.1',`one ${runtime} 19.3.1`);
    assert.equal(realpathSync(join(scope,'..',runtime)),one,`the stack uses the application's ${runtime}`);
    assert.equal(realpathSync(join(dirname(realpathSync(join(scope,'react'))),'..',runtime)),one,`@saga-a2ui/react uses the same ${runtime}`);
  }
});

// ---- One stack: production code imports only its subpaths, and the browser graph holds no server module.
test('production code imports SAGA only through the one stack, and the browser bundle holds no server module',()=>{
  const sources=(dir:string):string[]=>readdirSync(join(root,dir),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(`${dir}/${entry.name}`):/\.(?:ts|tsx)$/.test(entry.name)?[`${dir}/${entry.name}`]:[]);
  for(const file of [...sources('src'),'scripts/build.ts']) {
    const imported=[...readFileSync(join(root,file),'utf8').matchAll(/from\s+'(@saga-a2ui\/[^']+)'/g)].map(match=>match[1]);
    for(const specifier of imported) assert.match(specifier,/^@saga-a2ui\/react-mcp-stack(?:\/(?:faithful-card|faithful-card\.css|content-policy|server|server\/http))?$/,`${file} imports ${specifier}`);
    if(file.startsWith('src/view/')) assert.ok(!imported.some(specifier=>specifier.endsWith('/server')),`${file} (browser graph) imports no server entry`);
  }
  const html=readFileSync(join(root,'dist/view.html'),'utf8');
  assert.ok(!html.includes('The MCP server already ends a different request lifetime.'),'the view bundle holds no server lifetime module');
});

// ---- The card document names the SDK release it was built from, beside the application release.
test('the emitted card document carries the registry SDK identity beside the application release',()=>{
  const html=readFileSync(join(root,'dist/view.html'),'utf8');
  const expected={kind:'registry',version:SDK_VERSION,source:'none','stack-sha256':'none','set-sha256':'none'};
  const body=/<body\b[^>]*>/.exec(html)?.[0]??'';
  for(const [name,value] of Object.entries(expected)) assert.equal(body.match(new RegExp(`\\sdata-sdk-${name}="([^"]*)"`))?.[1],value,`data-sdk-${name}`);
  assert.equal(body.match(/\sdata-release="([^"]*)"/)?.[1],JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,'the application release stays beside the SDK identity');
  assert.ok(html.includes(`<meta name="ansari-sdk" content="${SDK_VERSION}"`));
  assert.deepEqual(JSON.parse(node('scripts/sdk-identity.mjs')),{kind:'registry',version:SDK_VERSION,source:'none',stackSha256:'none',setSha256:'none'});
});

test('distributed HTML retains complete installed SAGA and font licence notices', () => {
  const html = readFileSync(join(root, 'dist/view.html'), 'utf8');
  const comment = /<!--\nBEGIN THIRD-PARTY LICENCES\n([\s\S]*?)\nEND THIRD-PARTY LICENCES\n-->/.exec(html)?.[1];
  assert.ok(comment, 'the distributed card carries the licence comment');
  const notices = comment.replaceAll('-&#45;', '--');
  const stack = realpathSync(join(root, 'node_modules/@saga-a2ui/react-mcp-stack'));
  assert.ok(notices.includes(readFileSync(join(stack, 'LICENSE'), 'utf8').trim()));
  assert.ok(notices.includes(readFileSync(join(dirname(stack), 'components/THIRD_PARTY_NOTICES.md'), 'utf8').trim()));
  assert.ok(notices.includes(readFileSync(join(root, 'assets/fonts/OFL.txt'), 'utf8').trim()));
  assert.ok(notices.includes(readFileSync(join(root, 'assets/NOTICE.md'), 'utf8').trim()));
  for (const name of SIBLINGS) assert.ok(notices.includes(ref(name)), ref(name));
});

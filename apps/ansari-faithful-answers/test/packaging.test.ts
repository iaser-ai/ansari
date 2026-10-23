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

// ---- The SAGA packages: one exact public npm release, never a tag, range, tarball or local file.
// The expected values below were read from the public npm registry (`npm view @saga-a2ui/<name>@0.7.6-rc.1 dist.integrity`),
// not from the files they are compared with.
const SDK_VERSION='0.7.6-rc.1';
const SDK_INTEGRITY:Record<string,string>={
  core:'sha512-G32+/oIWhm53bNNUfRZBFrRAHhgYYrIAbSjZssw9L4oWfe0vktW+SHi8xKegUCTV8h8HXqa0dtzorkhPh6dHhg==',
  components:'sha512-nNEINbHUpvnpK7HoYkF5lsdjAH7SZ7VkhxNQBH3rCe4ZeuPrSY19QdaN6c7PpG+PNU/PDi42mc2Nkn9h1mRXgQ==',
  mcp:'sha512-faDfWQVW7yDmZ9EeogaUb2CReyZ6aEvPjAeE3u8vcjnwJ84m5Rd5h5ddbXDXQCUqXQRpoxfTiSgG6lpxsZSPaA==',
  react:'sha512-rx6uVKDHsTWcY5JlUXr22OYh4nvdiQ83xEOd5Fl3qEIPxRQQZKgGbZnoeO0YbUvyEokINcGciNg/T+JRkp2jew==',
  'react-mcp-stack':'sha512-Lg+Ev6rXya1zccpYaZRoJcdfLj70DDnA/S+dFo0CKo0mhDwnED2cMkAtluPJy+UQ2GlfHduCULiGhMKVszD/Bg==',
};
const SIBLINGS=Object.keys(SDK_INTEGRITY);
const pinned:string=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies['@saga-a2ui/react-mcp-stack'];
const node=(...args:string[])=>execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'});

test('the manifest pins one exact public version for every SAGA package it imports',()=>{
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const saga=Object.entries<string>({...manifest.dependencies,...manifest.devDependencies}).filter(([name])=>name.startsWith('@saga-a2ui/'));
  assert.deepEqual(saga.map(([name])=>name).sort(),['@saga-a2ui/react-mcp-stack']);
  for(const [name,version] of saga) {
    assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,`${name} is an exact version, never a tag or range`);
    assert.equal(version,SDK_VERSION,name);
  }
  assert.ok(!JSON.stringify(manifest).includes('catalog:'),'no monorepo-only catalog reference');
  assert.ok(!/"(?:file|link|workspace|git\+?[a-z]*|https?):/.test(JSON.stringify({...manifest.dependencies,...manifest.devDependencies,overrides:manifest.overrides,pnpm:manifest.pnpm})),'no local, tarball or workspace dependency source');
});

// Every lockfile that installs this application: the application's own (standalone installation) and, when this folder sits
// in a monorepo, the workspace root's.
const lockfiles:Array<{label:string;text:string;prefix:string}>=[];
if(existsSync(join(root,'pnpm-lock.yaml'))) lockfiles.push({label:'application',text:readFileSync(join(root,'pnpm-lock.yaml'),'utf8'),prefix:''});
const workspaceLock=join(root,'../../pnpm-lock.yaml');
if(existsSync(workspaceLock)&&existsSync(join(root,'../../pnpm-workspace.yaml'))) lockfiles.push({label:'workspace root',text:readFileSync(workspaceLock,'utf8'),prefix:'apps/ansari-faithful-answers'});

test('every lockfile resolves the five SAGA packages to the public registry with the registry integrity',()=>{
  assert.ok(lockfiles.length>0,'at least one lockfile installs this application');
  for(const {label,text} of lockfiles) {
    for(const sibling of SIBLINGS) {
      const key=`'@saga-a2ui/${sibling}@${SDK_VERSION}':\n    resolution: {integrity: ${SDK_INTEGRITY[sibling]}}`;
      assert.ok(text.includes(key),`${label} lockfile locks ${sibling} to the registry release with its integrity`);
    }
    // Nothing else from @saga-a2ui, no second SAGA version, and no local source of any kind for it.
    const resolved=[...new Set([...text.matchAll(/^ {2}'(@saga-a2ui\/[a-z-]+)@([^':(]+)':$/gm)].map(match=>`${match[1]}@${match[2]}`))].sort();
    assert.deepEqual(resolved,SIBLINGS.map(sibling=>`@saga-a2ui/${sibling}@${SDK_VERSION}`).sort(),`${label} lockfile: exactly the five packages at one version`);
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
    assert.match(workspace,/'?"?@a2ui\/markdown-it"?'?\s*:\s*['"]0\.2\.1['"]/,`${file} pins the A2UI Markdown adapter`);
  }
  assert.equal(existsSync(join(root,'candidates')),false,'no local SAGA inputs are committed');
});

test('the installed tree has strict same-version siblings and one framework runtime',()=>{
  const modules=join(root,'node_modules');
  const scope=dirname(realpathSync(join(modules,'@saga-a2ui/react-mcp-stack')));
  for(const sibling of SIBLINGS) {
    const installed=JSON.parse(readFileSync(join(scope,sibling,'package.json'),'utf8'));
    assert.equal(installed.name,`@saga-a2ui/${sibling}`);
    assert.equal(installed.version,pinned,`${sibling} is the pinned SAGA version`);
    // Every SDK sibling it depends on or needs as a peer is the same version.
    for(const field of ['dependencies','peerDependencies']) for(const [dependency,range] of Object.entries<string>(installed[field]??{})) if(dependency.startsWith('@saga-a2ui/')) assert.equal(range,pinned,`${sibling} ${field} ${dependency}`);
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
    for(const specifier of imported) assert.match(specifier,/^@saga-a2ui\/react-mcp-stack(?:\/(?:faithful-card|faithful-card\.css|content-policy|server))?$/,`${file} imports ${specifier}`);
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

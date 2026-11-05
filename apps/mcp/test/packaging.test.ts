import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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

// ---- The SAGA packages: one exact version from one source, never a tag, range or machine path.
// A public release resolves from the npm registry with the integrity below, read from the registry
// (`npm view @saga-a2ui/<name>@<version> dist.integrity`), not from the files compared with it. Until a release is on the
// registry, a private candidate (`0.0.0-candidate.g<commit>`) resolves from the tarballs committed under candidates/,
// and the lockfile must record exactly their bytes.
const REGISTRY_INTEGRITY:Record<string,Record<string,string>>={
  '0.7.6':{
    core:'sha512-m+ynUS2+f36exYwqimAnnjxtVKJ1+Xm2Zscja+kWI9iFoDxVtT6C2lYxO6exSSXyi4LreJMgFhQsKh0hsaMVDg==',
    components:'sha512-Gpm2uc2VbXNrxfWNy2uHfdJYdzNf5ewZKTpsaO5nsLSF0ymDjwzJ45h0BiVD77zyO4KXmDb2QipuCraTbqFApQ==',
    mcp:'sha512-LBBOUhhagKZszb+Y6ooZSNDvJs3GZ6EE+Ysk8gsSVkxWrGRdcg5j3GgY/jcYF8K1NzEFQw75rm1KhM+C210ZAA==',
    react:'sha512-6oz4GAWZzLjsysHSPKw6zOqYFF5D+bAcp9CtGJ5Exc/9Z+x2OM4Sn7oHMdul47iDMEJi9WNbrI5+DSGvii1a3g==',
    'react-mcp-stack':'sha512-ZYv9uL9FAjVRrfboabT6YRu6zHO8JOQKXc9D2pYskpacCRpezsVrQpNtjbh2TUDOdaY+SYEDIAl8+Js1U0oJqQ==',
  },
};
const SIBLINGS=['core','components','mcp','react','react-mcp-stack'];
const pinned:string=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies['@saga-a2ui/react-mcp-stack'];
const SDK_VERSION=pinned;
const CANDIDATE=/^0\.0\.0-candidate\.g([0-9a-f]{12})$/.exec(pinned);
const CANDIDATE_DIR=`candidates/saga-${pinned}`;
const candidateFile=(sibling:string)=>`${CANDIDATE_DIR}/saga-a2ui-${sibling}-${pinned}.tgz`;
const digest=(algorithm:string,file:string,encoding:'hex'|'base64')=>createHash(algorithm).update(readFileSync(join(root,file))).digest(encoding);
/** The integrity each sibling must resolve with: the registry's for a release, the committed tarball's for a candidate. */
function expectedIntegrity(sibling:string):string{
  if(CANDIDATE) return `sha512-${digest('sha512',candidateFile(sibling),'base64')}`;
  const known=REGISTRY_INTEGRITY[SDK_VERSION];
  assert.ok(known,`record the registry integrity of every SAGA package at ${SDK_VERSION} (npm view @saga-a2ui/<name>@${SDK_VERSION} dist.integrity)`);
  return known[sibling];
}
const node=(...args:string[])=>execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'});

test('the manifest pins one exact version for every SAGA package it imports',()=>{
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const saga=Object.entries<string>({...manifest.dependencies,...manifest.devDependencies}).filter(([name])=>name.startsWith('@saga-a2ui/'));
  assert.deepEqual(saga.map(([name])=>name).sort(),['@saga-a2ui/react-mcp-stack']);
  for(const [name,version] of saga) assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,`${name} is an exact version, never a tag or range`);
  assert.equal(manifest.devDependencies.typescript, 'catalog:');
  assert.equal(manifest.devDependencies.eslint, 'catalog:');
  assert.equal(manifest.devDependencies['@ansari/eslint-config'], 'workspace:*');
  assert.ok(!/"(?:file|link|workspace|git\+?[a-z]*|https?):/.test(JSON.stringify({...manifest.dependencies,overrides:manifest.overrides,pnpm:manifest.pnpm})),'no local, tarball or workspace dependency source in the manifest');
});

// The lockfile that installs this application: the workspace root's. The application has none of its own (asserted below).
const lockfiles:Array<{label:string;text:string;prefix:string}>=[];
assert.equal(existsSync(join(root,'pnpm-lock.yaml')), false, 'only the root lockfile installs the app');
assert.equal(existsSync(join(root,'pnpm-workspace.yaml')), false, 'only the root workspace config applies');
const workspaceLock=join(root,'../../pnpm-lock.yaml');
if(existsSync(workspaceLock)&&existsSync(join(root,'../../pnpm-workspace.yaml'))) lockfiles.push({label:'workspace root',text:readFileSync(workspaceLock,'utf8'),prefix:'apps/mcp'});

test('every lockfile resolves the five SAGA packages from one source with that source\'s integrity',()=>{
  assert.ok(lockfiles.length>0,'at least one lockfile installs this application');
  for(const {label,text,prefix} of lockfiles) {
    const ref=(sibling:string)=>CANDIDATE?`file:${prefix}/${candidateFile(sibling)}`:SDK_VERSION;
    for(const sibling of SIBLINGS) {
      const resolution=CANDIDATE?`{integrity: ${expectedIntegrity(sibling)}, tarball: ${ref(sibling)}}`:`{integrity: ${expectedIntegrity(sibling)}}`;
      assert.ok(text.includes(`'@saga-a2ui/${sibling}@${ref(sibling)}':\n    resolution: ${resolution}`),`${label} lockfile locks ${sibling} to ${CANDIDATE?'the committed candidate tarball':'the registry release'} with its integrity`);
    }
    // Nothing else from @saga-a2ui, no second SAGA version, and no other local source for it.
    const resolved=[...new Set([...text.matchAll(/^ {2}'(@saga-a2ui\/[a-z-]+)@([^'(]+)':$/gm)].map(match=>`${match[1]}@${match[2]}`))].sort();
    assert.deepEqual(resolved,SIBLINGS.map(sibling=>`@saga-a2ui/${sibling}@${ref(sibling)}`).sort(),`${label} lockfile: exactly the five packages from one source`);
    if(!CANDIDATE) assert.doesNotMatch(text,/@saga-a2ui\/[a-z-]+@file:|tarball: file:/,`${label} lockfile: no local file`);
    assert.doesNotMatch(text,/@saga-a2ui\/lit/,`${label} lockfile: no Lit package`);
    assert.doesNotMatch(text,/(?:\/tmp\/|\/opt\/|\/Users\/|\/home\/|[A-Za-z]:\\)/,`${label} lockfile records no machine path`);
  }
});

test('workspace overrides name a SAGA package only to install a committed candidate',()=>{
  const files=[join(root,'pnpm-workspace.yaml'),join(root,'../../pnpm-workspace.yaml')].filter(file=>existsSync(file));
  assert.ok(files.length>0);
  for(const file of files) {
    const workspace=readFileSync(file,'utf8');
    const overrides=[...workspace.matchAll(/^ {2}['"]?(@saga-a2ui\/[^'":]+)['"]?\s*:\s*['"]?([^'"\n]+)['"]?$/gm)].map(([,name,value])=>`${name}=${value}`).sort();
    assert.deepEqual(overrides,CANDIDATE?SIBLINGS.map(sibling=>`@saga-a2ui/${sibling}=file:apps/mcp/${candidateFile(sibling)}`).sort():[],`${file}: ${CANDIDATE?'every sibling, and only the siblings, from the candidate set':'no SAGA override'}`);
    if(!CANDIDATE) assert.doesNotMatch(workspace,/file:|link:/,`${file} has no local-file dependency source`);
    assert.doesNotMatch(workspace,/link:/,`${file} links no local package`);
    assert.match(workspace,/['"]@a2ui\/react@0\.13\.0>@a2ui\/markdown-it['"]\s*:\s*['"]0\.2\.1['"]/,`${file} pins the A2UI Markdown adapter`);
  }
  if(!CANDIDATE) assert.equal(existsSync(join(root,'candidates')),false,'no local SAGA inputs are committed');
  else assert.deepEqual(readdirSync(join(root,'candidates')),[`saga-${pinned}`],'one candidate set, the pinned one');
  if(CANDIDATE) assert.deepEqual(readdirSync(join(root,CANDIDATE_DIR)).sort(),SIBLINGS.map(sibling=>`saga-a2ui-${sibling}-${pinned}.tgz`).sort(),'the candidate set holds exactly the five tarballs');
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

// ---- The card document names the SDK it was built from, beside the application release.
test('the emitted card document carries the SDK identity beside the application release',()=>{
  const html=readFileSync(join(root,'dist/view.html'),'utf8');
  // A candidate is named by its source commit and the bytes of its tarballs, recomputed here from the committed files.
  const set=CANDIDATE?createHash('sha256').update(SIBLINGS.map(sibling=>`saga-a2ui-${sibling}-${pinned}.tgz`).sort().map(name=>`${name} ${digest('sha256',`${CANDIDATE_DIR}/${name}`,'hex')}\n`).join('')).digest('hex'):'none';
  const identity=CANDIDATE
    ?{kind:'candidate',version:SDK_VERSION,source:CANDIDATE[1],stackSha256:digest('sha256',candidateFile('react-mcp-stack'),'hex'),setSha256:set}
    :{kind:'registry',version:SDK_VERSION,source:'none',stackSha256:'none',setSha256:'none'};
  const expected={kind:identity.kind,version:identity.version,source:identity.source,'stack-sha256':identity.stackSha256,'set-sha256':identity.setSha256};
  const body=/<body\b[^>]*>/.exec(html)?.[0]??'';
  for(const [name,value] of Object.entries(expected)) assert.equal(body.match(new RegExp(`\\sdata-sdk-${name}="([^"]*)"`))?.[1],value,`data-sdk-${name}`);
  assert.equal(body.match(/\sdata-release="([^"]*)"/)?.[1],JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,'the application release stays beside the SDK identity');
  assert.ok(html.includes(`<meta name="ansari-sdk" content="${SDK_VERSION}"`));
  assert.deepEqual(JSON.parse(node('scripts/sdk-identity.mjs')),identity);
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
  for (const name of SIBLINGS) assert.ok(notices.includes(`@saga-a2ui/${name}@${SDK_VERSION}`));
});

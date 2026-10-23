import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// The copy boundaries (Docker build context and the standalone verification copy) must not carry
// credentials or local runtime state. Everything here is a synthetic marker; no real secret file is read.
const root=fileURLToPath(new URL('../',import.meta.url));
const MARKER='synthetic-marker-not-a-secret';
const NEVER_COPIED=['.env','.env.local','.dev.vars','.dev.vars.staging','.dev.vars.production','.wrangler/state/v3/cache.sqlite','dist-worker/index.js','node_modules/x/index.js','dist/view.html','.npmrc'];
const copied=['package.json','src/node/index.ts','wrangler.jsonc'];

const seed=(base:string,names:string[],nested='')=>{
  for(const name of names) {
    const file=join(base,nested,name);
    mkdirSync(dirname(file),{recursive:true});
    writeFileSync(file,MARKER);
  }
};
const files=(base:string):string[]=>readdirSync(base,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(base,entry.name)).map(name=>join(entry.name,name)):[entry.name]);

// A minimal Docker ignore matcher: `*` stays within a path segment, `**` crosses segments, and a
// matching parent directory excludes everything beneath it.
const toRegExp=(pattern:string)=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*\/?/g,'\u0000').replace(/\*/g,'[^/]*').replace(/\u0000/g,'(?:.*/)?')+'$');
const ignored=(patterns:string[],path:string)=>{
  const parts=path.split('/');
  let excluded=false;
  for(const pattern of patterns) {
    const negate=pattern.startsWith('!');
    const re=toRegExp(negate?pattern.slice(1):pattern);
    if(parts.some((_,index)=>re.test(parts.slice(0,index+1).join('/')))) excluded=!negate;
  }
  return excluded;
};
const patternsOf=(file:string)=>readFileSync(file,'utf8').split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));

test('the standalone verification copy leaves out credentials and local runtime state',()=>{
  const work=mkdtempSync(join(tmpdir(),'copy-boundary-'));
  try {
    const source=join(work,'source');
    const dest=join(work,'dest');
    seed(source,[...NEVER_COPIED,...copied]);
    seed(source,['.dev.vars','.dev.vars.staging'],'nested');
    execFileSync('bash',[join(root,'scripts/copy-app-source.sh'),source,dest],{encoding:'utf8'});
    assert.deepEqual(files(dest).sort(),[...copied].sort());
  } finally {
    rmSync(work,{recursive:true,force:true});
  }
});

test('the Docker build context excludes the Worker secret files and local state',()=>{
  const contexts:Array<[string,string[]]>=[[join(root,'.dockerignore'),NEVER_COPIED.filter(name=>name!=='.npmrc')]];
  const repoIgnore=join(root,'../../.dockerignore');
  if(existsSync(repoIgnore)&&statSync(repoIgnore).isFile()) {
    contexts.push([repoIgnore,['.dev.vars','.dev.vars.staging','apps/ansari-faithful-answers/.dev.vars','apps/ansari-faithful-answers/.dev.vars.production','apps/ansari-faithful-answers/.wrangler/state/x','apps/ansari-faithful-answers/dist-worker/index.js']]);
  }
  for(const [file,secrets] of contexts) {
    const patterns=patternsOf(file);
    for(const secret of secrets) assert.ok(ignored(patterns,secret),`${relative(root,file)} excludes ${secret}`);
    for(const kept of ['package.json','src/node/index.ts','wrangler.jsonc']) assert.ok(!ignored(patterns,kept),`${relative(root,file)} keeps ${kept}`);
  }
});

import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

test('a completed subscription exchange releases timers even when its MCP server was never connected',async()=>{
  const fixture=fileURLToPath(new URL('./fixtures/closed-subscription.ts',import.meta.url));
  const result=await new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>{
    execFile(process.execPath,['--import','tsx',fixture],{timeout:2500},(error,stdout,stderr)=>resolve({error,stdout,stderr}));
  });
  assert.match(result.stdout,/exchange and listener closed/,'the HTTP exchange itself must finish');
  assert.equal(result.error,null,`a disposed request still keeps the process alive: ${result.error?.message}\n${result.stderr}`);
});

for(const modern of [true,false]) test(`SIGTERM exits with an in-flight ${modern?'modern':'older-host'} SSE tool request`,async()=>{
  let started!:()=>void;
  const sourceStarted=new Promise<void>(resolve=>{started=resolve;});
  // A real upstream HTTP request that deliberately never sends an answer.
  const upstream=createServer(async(req)=>{
    for await(const _ of req) { /* consume the request before marking the work started */ }
    started();
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const address=upstream.address();assert.ok(address&&typeof address==='object');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server/index.js',import.meta.url))],{
    env:{...process.env,PORT:'0',MCP_RESPONSE_MODE:'sse',ANSARI_API_BASE_URL:`http://127.0.0.1:${address.port}`},
    stdio:['ignore','pipe','pipe'],
  });
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const lines=createInterface({input:child.stdout});
  const controller=new AbortController();
  let pending:Promise<unknown>|undefined;
  try {
    const startup=await Promise.race([
      (async()=>{for await(const line of lines){const log=JSON.parse(line);if(log.event==='startup')return log.port as number;}throw new Error(`server did not start: ${stderr}`);})(),
      new Promise<never>((_,reject)=>{AbortSignal.timeout(3000).addEventListener('abort',()=>reject(new Error('startup timed out')),{once:true});}),
    ]);
    pending=fetch(`http://127.0.0.1:${startup}/mcp`,{
      method:'POST',signal:controller.signal,
      headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(modern?{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'ask_ansari'}:{})},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_ansari',arguments:{question:'synthetic'},_meta:{progressToken:'shutdown',...(modern?{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'shutdown-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{},
      }:{})}}}),
    }).then(response=>response.text()).catch(()=>undefined);
    await Promise.race([
      sourceStarted,
      once(child,'exit').then(()=>{throw new Error(`server exited before calling upstream: ${stderr}`);}),
      new Promise<never>((_,reject)=>{AbortSignal.timeout(3000).addEventListener('abort',()=>reject(new Error(`upstream call did not start: ${stderr}`)),{once:true});}),
    ]);
    const exit=once(child,'exit',{signal:AbortSignal.timeout(2000)});
    child.kill('SIGTERM');
    const [code,signal]=await exit;
    assert.equal(code,0,stderr);assert.equal(signal,null);
  } finally {
    controller.abort();lines.close();
    if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    await pending;
    const stopped=new Promise<void>(resolve=>upstream.close(()=>resolve()));upstream.closeAllConnections();await stopped;
  }
});

test('every way a per-request MCP server ends releases its request timer',async()=>{
  const fixture=fileURLToPath(new URL('./fixtures/server-close.ts',import.meta.url));
  const result=await new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>{
    execFile(process.execPath,['--import','tsx',fixture],{timeout:2500},(error,stdout,stderr)=>resolve({error,stdout,stderr}));
  });
  assert.match(result.stdout,/servers closed/,result.stderr);
  assert.equal(result.error,null,`a closed server still keeps the process alive: ${result.error?.message}\n${result.stderr}`);
});

// Run through docker exec: the container has no external network or mounted files.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
const answer='3. Synthetic complete answer\n   1. Nested item\n\nالإجابة العربية\n\n*Answered by [Ansari](https://askansari.ai).*\n';
let calls=0;
const upstream=createServer(async(req,res)=>{
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.url,'/api/v2/mcp-complete');
  assert.equal(req.method,'POST');
  assert.equal(req.headers.authorization,undefined);
  calls++;
  if(body.messages[0].content==='fail') {res.writeHead(503);res.end('private upstream detail');return;}
  assert.equal(body.messages[0].content,'synthetic');
  res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end(answer);
});
await new Promise(resolve=>upstream.listen(4010,'127.0.0.1',resolve));
let id=0;
async function rpc(method,params={}) {
  const response=await fetch('http://127.0.0.1:3000/mcp',{
    method:'POST',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(params.name ? {'Mcp-Name':params.name} : params.uri ? {'Mcp-Name':params.uri} : {})},
    body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'synthetic-container',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}}),
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('mcp-session-id'),null);
  const data=await response.json();assert.equal(data.id,id);assert.equal(data.error,undefined);
  return data.result;
}
try {
  let health;
  for(let attempt=0;attempt<40;attempt++) {
    try {const r=await fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(1000)});if(r.ok){health=await r.json();break;}} catch {}
    await delay(250);
  }
  assert.equal(health?.ok,true,'container did not become healthy');
  assert.equal(health.release,'ci-public-smoke');
  const tools=await rpc('tools/list');assert.deepEqual(tools.tools.map(t=>t.name),['ask_ansari']);
  const resources=await rpc('resources/list');assert.equal(resources.resources.length,1);
  const uri=resources.resources[0].uri;
  assert.equal(tools.tools[0]._meta.ui.resourceUri,uri);
  const result=await rpc('tools/call',{name:'ask_ansari',arguments:{question:'synthetic'}});
  assert.notEqual(result.isError,true);
  assert.deepEqual(result.structuredContent,{version:'0.1.0',question:'synthetic',answer});
  assert.deepEqual(result.content,[{type:'text',text:answer}]);
  assert.equal(result._meta.ui.resourceUri,uri);
  const resource=await rpc('resources/read',{uri});const html=resource.contents[0].text;
  assert.equal(uri,`ui://views/answer-card.${createHash('sha256').update(html).digest('hex').slice(0,32)}.html`);
  assert.ok(html.includes('ci-public-smoke'));
  assert.ok(!html.includes('version https://git-lfs.github.com/spec/v1'));
  const failure=await rpc('tools/call',{name:'ask_ansari',arguments:{question:'fail'}});
  assert.equal(failure.isError,true);
  assert.ok(!JSON.stringify(failure).includes('private upstream detail'));
  const next=await rpc('tools/call',{name:'ask_ansari',arguments:{question:'synthetic'}});
  assert.equal(next.structuredContent.answer,answer);
  assert.equal(calls,3);
  console.log(JSON.stringify({health,tools:1,resources:1,answerPreserved:true,safeFailureAndRecovery:true,resourceUri:uri}));
} finally {await new Promise(resolve=>upstream.close(resolve));}

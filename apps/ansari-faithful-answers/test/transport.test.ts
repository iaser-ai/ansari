import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {listen} from '../src/node/http-server.js';
import {PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {createAnsariHttpCompleter} from '../src/server/ansari-client.js';

const answer = '3. Complete English answer\n   1. Nested item\n\nالإجابة العربية\n\n*Answered by [Ansari](https://askansari.ai).*\n';
async function resource(html: string) {
  const service = await listen({host:'127.0.0.1',port:0,html,logger:()=>{},completer:{async complete(){return answer;}}});
  const client = new Client({name:'synthetic',version:'1'});
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t=>t.name), ['ask_ansari']);
    const result = await client.callTool({name:'ask_ansari',arguments:{question:'synthetic'}});
    assert.deepEqual(result.structuredContent,{version:'0.1.0',question:'synthetic',answer});
    assert.deepEqual(result.content,[{type:'text',text:answer}]);
    const uri = (result._meta as {ui:{resourceUri:string}}).ui.resourceUri;
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map(r=>r.uri),[uri]);
    const read = await client.readResource({uri});
    const text = (read.contents[0] as {text:string}).text;
    assert.equal(uri,`ui://views/answer-card.${createHash('sha256').update(text).digest('hex').slice(0,32)}.html`);
    await assert.rejects(client.readResource({uri:'ui://obsolete.html'}));
    for(const path of ['/demo','/demo/answer','/fonts/amiri.ttf']) assert.equal((await fetch(`http://127.0.0.1:${service.port}${path}`)).status,404);
    return uri;
  } finally {await client.close();await service.close();}
}
test('one current resource, unchanged answer, MCP linkage and HTML identity', async()=>{
  const a=await resource('<html><body>one</body></html>');
  const b=await resource('<html><body>two</body></html>');
  assert.notEqual(a,b);
});
test('API client sends the question and preserves the complete response',async()=>{
  const client=createAnsariHttpCompleter({baseUrl:'https://synthetic.invalid/',fetchImpl:async(url,init)=>{
    assert.equal(url,'https://synthetic.invalid/api/v2/mcp-complete');
    assert.deepEqual(JSON.parse(String(init?.body)),{messages:[{role:'user',content:'question'}]});
    return new Response(answer);
  }});
  assert.equal(await client.complete({question:'question'}),answer);
});

async function postRpc(port: number, method: string, params: object = {}, extra: Record<string,string> = {}, modern = false) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {'content-type':'application/json', accept:'application/json, text/event-stream', ...(modern ? {'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...('name' in params ? {'Mcp-Name':String(params.name)} : {})} : {}), ...extra},
    body: JSON.stringify({jsonrpc:'2.0', id:1, method, params: modern ? {...params,_meta:{[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_INFO_META_KEY]:{name:'stateless-test',version:'1'},[CLIENT_CAPABILITIES_META_KEY]:{}}} : params}),
  });
}

for (const modern of [true,false]) test(`MCP ${modern ? '2026' : 'older-host'} discovery and concurrent tools work without initialization or a session`, async () => {
  const service = await listen({host:'127.0.0.1', port:0, html:'<html><body>stateless</body></html>', logger:()=>{}, completer:{async complete({question}) { return `Answer: ${question}`; }}});
  try {
    const listed = await postRpc(service.port, 'tools/list',{}, {},modern);
    assert.equal(listed.status,200,await listed.clone().text());
    assert.equal(listed.headers.get('mcp-session-id'),null);
    assert.deepEqual((await rpcPayload(listed)).result.tools.map((t:{name:string})=>t.name),['ask_ansari']);
    const replies = await Promise.all(['one','two'].map(async question => {
      const response = await postRpc(service.port,'tools/call',{name:'ask_ansari', arguments:{question}}, {},modern);
      assert.equal(response.status,200);
      assert.equal(response.headers.get('mcp-session-id'),null);
      const payload = await rpcPayload(response);
      return payload.result.structuredContent;
    }));
    assert.deepEqual(replies, ['one','two'].map(question=>({version:'0.1.0',question,answer:`Answer: ${question}`})));
    for (const method of ['GET','DELETE']) {
      assert.equal((await fetch(`http://127.0.0.1:${service.port}/mcp`,{method})).status,405);
    }
  } finally { await service.close(); }
});

test('the view is prepared before listening and reused across independent clients', async () => {
  let reads = 0;
  const options = {
    host:'127.0.0.1', port:0, logger:()=>{},
    get html() { reads += 1; return `<html><body>read ${reads}</body></html>`; },
    completer:{async complete() { return answer; }},
  };
  const service = await listen(options);
  try {
    assert.equal(reads,1,'prepare the HTML before opening the listener');
    const contents: string[] = [];
    for (let i=0;i<2;i++) {
      const client = new Client({name:'independent',version:'1'});
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`)));
        const listed = await client.listResources();
        const read = await client.readResource({uri:listed.resources[0]!.uri});
        contents.push((read.contents[0] as {text:string}).text);
      } finally { await client.close(); }
    }
    assert.equal(reads,1,'requests must not reread or prepare a different view');
    assert.equal(contents[0],contents[1]);
  } finally { await service.close(); }
});

async function rpcPayload(response: Response) {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
  const terminal = text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(message=>message.id===1);
  assert.ok(terminal, 'expected a terminal RPC response');
  return terminal;
}

test('Hono rejects untrusted Host/Origin and malformed requests before calling Ansari', async () => {
  let calls = 0;
  const service = await listen({host:'127.0.0.1',port:0,html:'<html><body>safe</body></html>',logger:()=>{},completer:{async complete(){calls++;return answer;}}});
  try {
    const params = {name:'ask_ansari',arguments:{question:'synthetic'}};
    const hostStatus = await new Promise<number | undefined>((resolve,reject)=>{
      const req = httpRequest(`http://127.0.0.1:${service.port}/mcp`,{method:'POST',headers:{host:'other.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end();
    });
    assert.equal(hostStatus,403);
    assert.equal((await postRpc(service.port,'tools/call',params,{origin:'https://other.example'})).status,403);
    const malformed = await fetch(`http://127.0.0.1:${service.port}/mcp`, {method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:'{'});
    assert.equal(malformed.status,400);
    assert.equal(calls,0);
    const valid = await postRpc(service.port,'tools/call',params,{origin:'http://localhost:1234'});
    assert.equal(valid.status,200);
    assert.equal((await rpcPayload(valid)).result.structuredContent.answer,answer);
    assert.equal(calls,1);
  } finally { await service.close(); }
});

for(const json of [false,true]) test(`modern ${json?'JSON':'SSE'} delivers the answer with a requested progress token`,async()=>{
  const service=await listen({host:'127.0.0.1',port:0,html:'<html><body>progress</body></html>',enableJsonResponse:json,logger:()=>{},completer:{async complete(){return answer;}}});
  try {
    const response=await postRpc(service.port,'tools/call',{name:'ask_ansari',arguments:{question:'synthetic'}}, {},true);
    assert.ok(!(await response.text()).includes('notifications/progress'),'do not send progress unless requested');
    const tokenResponse=await fetch(`http://127.0.0.1:${service.port}/mcp`,{
      method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'ask_ansari'},
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ask_ansari',arguments:{question:'synthetic'},_meta:{
        progressToken:'progress-test',[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_INFO_META_KEY]:{name:'progress-test',version:'1'},[CLIENT_CAPABILITIES_META_KEY]:{},
      }}}),
    });
    assert.equal(tokenResponse.status,200);
    const text=await tokenResponse.text();
    if(json){
      assert.match(tokenResponse.headers.get('content-type')??'',/application\/json/);
      assert.equal(JSON.parse(text).result.structuredContent.answer,answer);
      assert.ok(!text.includes('notifications/progress'));
    } else {
      const messages=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
      assert.deepEqual(messages.find(message=>message.method==='notifications/progress')?.params,{progressToken:'progress-test',progress:0,total:1});
      assert.equal(messages.find(message=>message.id===2)?.result.structuredContent.answer,answer);
    }
  } finally {await service.close();}
});

for(const modern of [true,false]) test(`${modern?'modern':'older-host'} refuses a body over the SDK limit before calling Ansari`,async()=>{
  let calls=0;
  const service=await listen({host:'127.0.0.1',port:0,html:'<html><body>bounded body</body></html>',logger:()=>{},completer:{async complete(){calls++;return answer;}}});
  try {
    const response=await postRpc(service.port,'tools/call',{name:'ask_ansari',arguments:{question:'x'.repeat(4*1024*1024)}},{},modern);
    assert.equal(response.status,413);
    assert.match(await response.text(),/Payload Too Large/);
    assert.equal(calls,0);
  } finally {await service.close();}
});

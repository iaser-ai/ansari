import assert from 'node:assert/strict';
import {request} from 'node:http';
import {listen} from '../../src/node/http-server.ts';

// This modern path disposes its MCP server before connecting a transport.
// With no live HTTP sockets, the process must also release the request timer.
const service = await listen({
  host:'127.0.0.1', port:0, html:'<html><body>synthetic</body></html>',
  logger:()=>{}, completer:{async complete(){throw new Error('not a tool call');}},
});
try {
  const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'subscriptions/listen',params:{
    notifications:{},_meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientInfo':{name:'cleanup-test',version:'1'},
      'io.modelcontextprotocol/clientCapabilities':{},
    },
  }});
  const response = await new Promise<string>((resolve,reject)=>{
    const req = request(`http://127.0.0.1:${service.port}/mcp`,{
      method:'POST',agent:false,headers:{
        'content-type':'application/json',accept:'application/json, text/event-stream',
        'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'subscriptions/listen',
      },
    },res=>{
      assert.equal(res.statusCode,200);
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve(text));res.on('error',reject);
    });
    req.on('error',reject);req.end(body);
  });
  assert.match(response,/notifications\/subscriptions\/acknowledged/);
  assert.match(response,/"resultType":"complete"/);
} finally {await service.close();}
console.log('exchange and listener closed');

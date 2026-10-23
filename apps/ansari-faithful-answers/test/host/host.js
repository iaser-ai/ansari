import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import {PostMessageTransport} from '@modelcontextprotocol/ext-apps';
// Local host fixture. `connect` selects when the host installs its listener relative to loading the view:
//   'before' (default, also `true`)  AppBridge connected before iframe.src is set
//   'after'  / false                 iframe.src is set first; call connectNow(id) later
//   'reject'                         host answers ui/initialize with a JSON-RPC error
//   'never'                          host never answers ui/initialize
// `stats.openLinks` records URLs the view asked the host to open; `stats.openLinkMode` ('ok' | 'deny') chooses the answer.
// `sandbox` (string) sets the iframe sandbox attribute. `seen` records only JSON-RPC method names posted by the view.
const views=new Map();window.hostProbe={
 async create(id,url,connect=true,sandbox=null,openLinks=true){const mode=connect===true?'before':connect===false?'after':connect;const iframe=document.createElement('iframe');iframe.id=id;iframe.style.cssText='width:760px;height:900px';if(sandbox!==null)iframe.setAttribute('sandbox',sandbox);document.body.append(iframe);const stats={mode,openLinks:[],openLinkMode:'ok',initialized:false,loaded:false,answerCalls:0,hostErrors:[],sizeChanges:[],seen:[],rejected:0};const bridge=new AppBridge(null,{name:'Local cross-origin host',version:'0.0.0'},{serverTools:{},...(openLinks?{openLinks:{}}:{})},{hostContext:{theme:'light'}});bridge.onsizechange=p=>stats.sizeChanges.push(p);bridge.onopenlink=async p=>{stats.openLinks.push(p.url);return stats.openLinkMode==='deny'?{isError:true}:{};};bridge.oninitialized=()=>{stats.initialized=true;};bridge.oncalltool=async()=>{stats.answerCalls++;return {content:[]};};bridge.onerror=e=>stats.hostErrors.push(String(e));
  const entry={iframe,bridge,stats,connected:false,listener:undefined};views.set(id,entry);
  entry.listener=ev=>{if(ev.source!==iframe.contentWindow)return;const d=ev.data;if(d&&d.jsonrpc==='2.0'&&typeof d.method==='string'){stats.seen.push(d.method);if(mode==='reject'&&d.method==='ui/initialize'&&d.id!==undefined){stats.rejected++;iframe.contentWindow.postMessage({jsonrpc:'2.0',id:d.id,error:{code:-32603,message:'synthetic host rejection'}},'*');}}};
  window.addEventListener('message',entry.listener);iframe.addEventListener('load',()=>{stats.loaded=true;},{once:true});
  if(mode==='before')await window.hostProbe.connectNow(id);iframe.src=url;},
 async connectNow(id){const v=views.get(id);if(v.connected)return;v.connected=true;await v.bridge.connect(new PostMessageTransport(v.iframe.contentWindow,v.iframe.contentWindow));},
 async input(id){await views.get(id).bridge.sendToolInput({arguments:{question:'local probe'}});},
 async result(id,result){await views.get(id).bridge.sendToolResult(result);},
 async theme(id,theme){await views.get(id).bridge.sendHostContextChange({theme});},
 async hostContext(id,context){await views.get(id).bridge.sendHostContextChange(context);},
 resize(id,width,height){const iframe=views.get(id).iframe;iframe.style.width=width+'px';if(height!==undefined)iframe.style.height=height+'px';},
 teardown(id){return views.get(id).bridge.teardownResource({},{timeout:1200});},
 state(id){return views.get(id).stats;},
 remove(id){const v=views.get(id);window.removeEventListener('message',v.listener);v.iframe.remove();},
 async close(){for(const v of views.values()){window.removeEventListener('message',v.listener);await v.bridge.close().catch(()=>{});v.iframe.remove();}}
};

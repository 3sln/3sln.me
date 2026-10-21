// Ordinary app-local owner API. The server derives the actor; browsers never send an owner ID.
export const WEB_OPERATIONS=Object.freeze(['shell.conversation-create','receive.body','conversations.list','conversations.get','conversations.send','conversations.status','conversations.invitations','conversations.accept','contacts.list','contacts.add','contacts.remove','contacts.block','views.list','views.create','incoming.query','incoming.update','intake.requests','intake.rejected','intake.rescue','outbox.list','outbox.get','outbox.retry-missing']);
// Exact BB-B6/B4 operations; composition enables this map only once archive/key-holder ports are wired.
export const ARCHIVE_CAPABILITIES=Object.freeze({status:{operation:'archive.status'},checkpoint:{operation:'archive.checkpoint'},verify:{operation:'archive.verify'},export:{operation:'archive.export',confirm:true},import:{operation:'archive.import',confirm:true},rejoin:{operation:'conversations.rejoin',confirm:true}});
export const ARCHIVE_WEB_OPERATIONS=Object.freeze(Object.values(ARCHIVE_CAPABILITIES).map(c=>c.operation));
export function parseSSE(text){
 if(text.length>4*1048576)throw new Error('Progress response too large');
 return text.replace(/\r\n/g,'\n').split('\n\n').flatMap(block=>{let id,type='message';const data=[];for(const line of block.split('\n')){const i=line.indexOf(':'),key=i<0?line:line.slice(0,i),value=(i<0?'':line.slice(i+1)).replace(/^ /,'');if(key==='id')id=value;else if(key==='event')type=value;else if(key==='data')data.push(value);}if(!data.length)return [];return [{id,type,data:JSON.parse(data.join('\n'))}];});
}
export function httpMailbox({fetch=globalThis.fetch,token,base=globalThis.location?.origin,archiveEnabled=false}={}){
 const origin=new URL(base).origin;
 async function request(path,options={}){const bearer=await token();if(typeof bearer!=='string'||!bearer)throw Object.assign(new Error('Sign in'),{code:'unauthorized'});const response=await fetch(new URL(path,origin),{...options,signal:AbortSignal.timeout(15000),credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+bearer,...options.headers}});if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(new Error('Mailbox request failed'),{code:body.error??'network',status:response.status});}return response;}
 return {archive:archiveEnabled===true?ARCHIVE_CAPABILITIES:undefined,async run(name,{input={},id}={}){if(!WEB_OPERATIONS.includes(name)&&!(archiveEnabled===true&&ARCHIVE_WEB_OPERATIONS.includes(name)))throw new TypeError('Unsupported browser operation');return (await request('/api/web/operation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,input,...id!==undefined?{id}:{}})})).json();},async progress(after){
  const response=await request('/api/events',{headers:{Accept:'text/event-stream',...after?{'Last-Event-ID':after}:{}}});
  if(!response.headers.get('Content-Type')?.includes('text/event-stream'))throw new Error('Invalid progress response');
  // B8 returns finite SSE replay. Consume bounded chunks; reconnect/poll timing belongs to the host adapter.
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4*1048576)throw new Error('Progress response too large');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const events=parseSSE(text);return {events,reset:events.some(e=>e.type==='reset'),resumeToken:response.headers.get('X-Resume-Token')??events.at(-1)?.id??after};
 }};
}

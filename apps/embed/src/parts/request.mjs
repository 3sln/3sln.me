// IA-4 / incremental-authorization §7.2. Popup only; the app cannot inspect the provider document.
// Shell seam: requestPart(context) owns its prepare/session state via apply(message). The shell must route
// prepare-request through validatePrepareRequest, not the legacy prepare validator (2 KiB other-message limit).
import {Engine,Provider,Action,Query} from '../../../../vendor/ngin/index.js';
import {h,defined} from './dom.mjs';
import {openPopup,FLOW_TIMEOUT_MS,POLL_MS,MAX_HELLOS,validateHello} from '../bridge.mjs';
import {validatePrepareRequest,REQUEST_KINDS,requestText} from '../../../../packages/sdk/src/elements/request-protocol.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** Exact issuer origin + own popup handle + entry + state. Configure's hint never crosses the port. */
export function runRequestPopup({win,popup,issuer,prepare,createEntry,prove,signal,timeoutMs=FLOW_TIMEOUT_MS,pollMs=POLL_MS}){
 return new Promise(resolve=>{
  let entry=null,hellos=0,done=false;
  const finish=result=>{if(done)return;done=true;win.removeEventListener('message',message);clearInterval(poll);clearTimeout(timer);signal?.removeEventListener('abort',cancel);try{popup.close();}catch{}resolve(result);};
  const cancel=()=>finish({outcome:'canceled'});
  async function message(event){
   if(done||!entry||event.source!==popup||event.origin!==issuer)return;const m=event.data;
   if(validateHello(m,entry)&&hellos<MAX_HELLOS){++hellos;try{const proof=await prove({entry,challenge:m.challenge});if(!done)popup.postMessage({v:1,type:'bindle-embed-proof',proof},issuer);}catch{}return;}
   const code=prepare.intent==='grant-more',keys=['v','type','entry',...code?['code']:['result'],'state','iss'];
   if(!exact(m,keys)||m.v!==1||m.type!=='bindle-embed-done'||m.entry!==entry||m.state!==prepare.state||m.iss!==issuer||!hellos)return;
   if(code?typeof m.code!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(m.code):!['configured','unchanged'].includes(m.result))return;
   // An incremental flow creates no embed binding; there is no claim and no consent result in flow-ended.
   try{popup.postMessage({v:1,type:'bindle-embed-ack',entry},issuer);}catch{}
   finish({outcome:'completed',...code?{code:m.code,state:m.state,iss:m.iss}:{}});
  }
  win.addEventListener('message',message);
  const poll=setInterval(()=>{try{if(popup.closed)finish({outcome:'canceled'});}catch{finish({outcome:'unavailable'});}},pollMs),timer=setTimeout(cancel,timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
  Promise.resolve().then(createEntry).then(id=>{if(done)return;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(id)){finish({outcome:'unavailable'});return;}entry=id;try{popup.location.replace(`${issuer}/oauth/authorize?entry=${encodeURIComponent(id)}`);}catch{finish({outcome:'unavailable'});}},()=>finish({outcome:'unavailable'}));
 });
}
class IslandRequestAction extends Action{
 static deps=['requestModel','requestPlatform'];constructor(input={}){super();this.input=input;}
 async execute(resources,{dispatchFeed,engineFeed}){try{const result=await this.run(resources);dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:result}));}finally{engineFeed.dispatchEvent(new Event('request-changed'));}}
}
export class ApplyIslandRequest extends IslandRequestAction{
 static operation='island.request.apply';
 run({requestModel:m,requestPlatform:p}){
  const v=this.input;
  if(v.type==='prepare-request'){const prepare=validatePrepareRequest(v,{kind:m.props.kind??'grant-more',origins:[m.parentOrigin]});if(!prepare)return false;m.requestPrepare=prepare;return true;}
  if(v.type==='session'){if(v.subject!==null){try{if(new URL(v.subject).origin!==p.issuer)return false;}catch{return false;}}if(m.subject!==v.subject){m.requestAbort?.abort();m.requestPrepare=null;}m.subject=v.subject;return true;}
  return false;
 }
}
export class ActivateIslandRequest extends IslandRequestAction{
 static operation='island.request.activate';
 async run({requestModel:m,requestPlatform:p}){
  const prepare=m.requestPrepare,subject=m.subject;
  if(!p.enabled||!this.input.activation||m.flow||!subject||!prepare||prepare.intent!==(m.props.kind??'grant-more'))return null;
  m.flow='pending';p.send({v:1,type:'flow',phase:'started'});p.refresh();
  const end=outcome=>{m.flow=null;if(m.requestPrepare===prepare)m.requestPrepare=null;p.send({v:1,type:'flow',phase:'ended',outcome});p.refresh();return outcome;};
  if(m.sandboxed||new URL(prepare.redirectUri).origin!==m.parentOrigin)return end('unavailable');
  // open() runs before the first await. No popup means no entry, counters, worker or storage.
  const popup=p.open();if(!popup)return end('popup-blocked');
  const controller=new AbortController();m.requestAbort=controller;
  try{
   const worker=await p.worker();if(controller.signal.aborted){try{popup.close();}catch{}return end('canceled');}
   const result=await p.run({win:p.win,popup,issuer:p.issuer,prepare,signal:controller.signal,createEntry:()=>worker.call('createRequestEntry',{prepare,subjectConstraint:subject}),prove:args=>worker.call('proof',args)});
   if(controller.signal.aborted)return end('canceled');
   if(result.outcome==='completed'&&prepare.intent==='grant-more')p.send({v:1,type:'code',code:result.code,state:result.state,iss:result.iss});
   return end(result.outcome);
  }catch{try{popup.close();}catch{}return end('unavailable');}
  finally{if(m.requestAbort===controller)m.requestAbort=null;}
 }
}
export class IslandRequestState extends Query{
 static operation='island.request.state';static deps=['requestModel'];
 fetch({requestModel:m}){return Object.freeze({busy:!!m.flow,disabled:!m.subject||!m.requestPrepare});}
}
export const ISLAND_REQUEST_OPERATIONS=Object.freeze([ApplyIslandRequest,ActivateIslandRequest,IslandRequestState]);
export function createIslandRequestEngine({model,enabled=false,send,worker,issuer,win=globalThis.window,refresh=()=>{},open=()=>openPopup(win),run=runRequestPopup}={}){
 return new Engine({providers:{requestModel:Provider.fromSingleton(model),requestPlatform:Provider.fromSingleton({enabled:enabled===true,send,worker,issuer,win,refresh,open,run})}});
}
export function requestPart({model,send,worker,issuer,host,arming,win=globalThis.window,refresh=()=>{},enabled=false,locale=()=>win.document.documentElement.lang}){
 const engine=createIslandRequestEngine({model,send,worker,issuer,win,refresh,enabled}),hooks=arming.guard(()=>engine.dispatch(new ActivateIslandRequest({activation:true})));
 const leaving=()=>model.requestAbort?.abort();win.addEventListener('pagehide',leaving);
 return Object.freeze({engine,apply:message=>engine.dispatch(new ApplyIslandRequest(message)),start(){},update(){},dispose(){win.removeEventListener('pagehide',leaving);leaving();return engine.dispose();},view(){
  const text=requestText(locale()),kind=REQUEST_KINDS.includes(model.props.kind)?model.props.kind:'grant-more',label=kind==='configure'?text.settings:text.access;
  return h('button',h('span',label),h('span',` · ${host}`)).classes('control','signin',model.props.variant==='outline'?'outline':'filled').attrs(defined({type:'button',disabled:!enabled||!model.subject||!model.requestPrepare||!!model.flow?'':undefined,'aria-busy':model.flow?'true':'false'})).on(hooks);
 }});
}

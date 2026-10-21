// IA-4. Engine-first request policy; DOM and ports translate into these operations. Providers own every effect.
import {Engine,Provider,Action,Query} from '../../../../vendor/ngin/index.js';
import {REQUEST_KINDS,validatePrepareRequest} from './request-protocol.mjs';
const enabled=io=>io.config.INCREMENTAL_AUTH_ENABLED===true||io.config.INCREMENTAL_AUTH_ENABLED==='true';
const snapshot=s=>Object.freeze({busy:s.busy,held:s.held,outcome:s.outcome,prepared:s.prepared,result:s.result});
export async function performRequest(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',e=>{result=e.detail;});await feed.next('complete');return result;}
class RequestAction extends Action{
 static deps=['requestState','requestIO'];constructor(input={}){super();this.input=input;}
 async execute(resources,context){try{const result=await this.run(resources,context);context.dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:result}));}finally{context.engineFeed.dispatchEvent(new Event('request-changed'));}}
}
export class PrepareRequest extends RequestAction{
 static operation='sdk.request.prepare';
 async run({requestState:s,requestIO:io}){
  if(!enabled(io)||s.busy||s.held||!REQUEST_KINDS.includes(this.input.kind))return null;
  const epoch=++s.generation;s.prepared=null;
  const result=await io.transport.prepare(this.input);
  if(epoch!==s.generation||!enabled(io)){await io.transport.cancel(result?.state);return null;}
  const prepare=validatePrepareRequest(result?.prepare,{kind:this.input.kind,origins:[io.origin]});
  if(!prepare){await io.transport.cancel(result?.state);return null;}
  s.prepared=prepare;return prepare;
 }
}
export class RequestFlow extends RequestAction{
 static operation='sdk.request.flow';
 async run({requestState:s,requestIO:io}){
  if(!enabled(io))return null;
  const {phase,outcome}=this.input;
  if(phase==='started'){if(s.busy||s.held||!s.prepared)return null;s.busy=true;s.outcome=null;s.result=null;return {phase:'started'};}
  if(phase!=='ended'||!s.busy||!['completed','canceled','popup-blocked','unavailable'].includes(outcome))return null;
  const epoch=s.generation,prepare=s.prepared;s.prepared=null;
  try{
   if(outcome==='completed'){
    const result=await io.transport.complete({prepare,code:s.code});
    if(epoch!==s.generation)return null;
    s.result=result;const values=result?.fragments?.map(f=>f.outcome)??[];
    s.held=prepare.intent==='grant-more'&&values.some(v=>['declined','partial','unsupported','unavailable'].includes(v));
   }else await io.transport.cancel(prepare?.state);
   if(epoch!==s.generation)return null;
   s.outcome=outcome;return {phase:'ended',outcome};
  }catch(error){if(epoch!==s.generation)return null;s.held=error?.code==='rate_limited';s.outcome=s.held?'rate_limited':'unavailable';return {phase:'ended',outcome:s.outcome};}
  finally{if(epoch===s.generation){s.busy=false;s.code=null;}}
 }
}
export class ReceiveRequestCode extends RequestAction{
 static operation='sdk.request.code';
 run({requestState:s,requestIO:io}){
  const m=this.input,p=s.prepared;
  if(!enabled(io)||!s.busy||s.code||p?.intent!=='grant-more'||m.state!==p.state||m.iss!==io.issuer||typeof m.code!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(m.code))return false;
  s.code={code:m.code,state:m.state,iss:m.iss};return true;
 }
}
export class RedirectRequest extends RequestAction{
 static operation='sdk.request.redirect';
 async run({requestState:s,requestIO:io},{engineFeed}){
  if(!enabled(io)||!this.input.activation||s.busy||s.held||!REQUEST_KINDS.includes(this.input.kind))return null;
  const epoch=++s.generation;s.busy=true;s.outcome=null;
  engineFeed.dispatchEvent(new Event('request-changed'));
  try{
   await io.transport.cancel(s.prepared?.state);s.prepared=null;
   const result=await io.transport.redirect(this.input);
   if(epoch!==s.generation)return null;s.result=result;s.outcome=result?.outcome??'unavailable';
   s.held=['rate_limited','unchanged','declined'].includes(s.outcome)||result?.fragments?.some(f=>['declined','partial'].includes(f.outcome))===true;
   return {phase:'ended',outcome:s.outcome};
  }catch(error){if(epoch!==s.generation)return null;s.held=error?.code==='rate_limited';s.outcome=s.held?'rate_limited':'unavailable';return {phase:'ended',outcome:s.outcome};}
  finally{if(epoch===s.generation)s.busy=false;}
 }
}
export class CancelRequest extends RequestAction{
 static operation='sdk.request.cancel';
 async run({requestState:s,requestIO:io}){++s.generation;const state=s.prepared?.state;s.busy=false;s.prepared=null;s.code=null;s.result=null;s.outcome=null;if(this.input.sessionChanged)s.held=false;await io.transport.cancel(state);return true;}
}
export class RequestState extends Query{
 static operation='sdk.request.state';static deps=['requestState'];
 fetch({requestState:s}){return snapshot(s);}
 boot({requestState:s},{notify,engineFeed}){this.feed=engineFeed;this.changed=()=>notify(snapshot(s));engineFeed.addEventListener('request-changed',this.changed);this.changed();}
 kill(){this.feed?.removeEventListener('request-changed',this.changed);}
}
export const REQUEST_OPERATIONS=Object.freeze([PrepareRequest,RequestFlow,ReceiveRequestCode,RedirectRequest,CancelRequest,RequestState]);
export function createRequestEngine({config={},transport,origin,issuer}={}){
 if(!transport||!origin||!issuer)throw new TypeError('Request providers are required.');
 return new Engine({providers:{requestState:Provider.fromSingleton({generation:0,busy:false,held:false,outcome:null,prepared:null,code:null,result:null}),requestIO:Provider.fromSingleton({config,transport,origin,issuer})}});
}

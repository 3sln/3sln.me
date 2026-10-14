import {Action} from '../shared/stack.mjs';
export const snapshot=r=>r.state.snapshot();
export const publish=(r,ctx,patch)=>{if(r.current&&!r.current())return;r.state.transition(next=>Object.assign(next,patch));ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));};
// Asynchronous owner data may never survive a sign-out, account switch, or
// offline transition. Mutations share the existing portal's busy reservation.
export function expireOwner(r,ctx,generation=snapshot(r).beamGeneration??0){r.api.csrf=null;r.browser.storeSecret?.('developerContactURL',null);publish(r,ctx,{developerContact:null,incoming:null,incomingTicket:null,incomingView:'all',incomingError:'',incomingLoading:false,session:null,data:null,mcpRequest:null,mcpGrants:null,automation:null,conversations:{},beaming:{},beamGeneration:generation+1,busy:false,messageDetail:null,messageOutcome:null,messageRender:null,selected:null,modal:null,billing:null,billingLoading:false,billingError:'',notice:'',searchDraft:{},semanticPreferences:null,spaceSearch:{phase:'idle',items:[]},error:'Your session expired. Sign in again.'});}
export class OwnerFlow extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 mutation=true;
 constructor(detail={}){super();this.detail=detail;}
 async execute(resources,ctx){const initial=snapshot(resources);if(!initial.session?.account||initial.offline)return;const owner=initial.session.account.id,generation=initial.beamGeneration??0;
  const current=()=>snapshot(resources).session?.account?.id===owner&&!snapshot(resources).offline&&(snapshot(resources).beamGeneration??0)===generation;
  if(this.mutation&&!resources.state.reserve())return;
  const r={...resources,current};const invoke=async(method,args)=>{if(!current())throw Error('Account changed.');let result;try{result=await resources.api[method](...args);}catch(error){if(error.status===401&&current()&&!(method==='request'&&args[3]?.dispatchToken)){resources.api.csrf=null;resources.state.transition(next=>Object.assign(next,{incoming:null,incomingTicket:null,incomingView:'all',incomingError:'',incomingLoading:false,session:null,data:null,mcpRequest:null,mcpGrants:null,automation:null,conversations:{},beaming:{},beamGeneration:generation+1,busy:false,messageDetail:null,messageOutcome:null,messageRender:null,selected:null,modal:null,billing:null,billingLoading:false,billingError:'',notice:'',searchDraft:{},semanticPreferences:null,spaceSearch:{phase:'idle',items:[]},error:'Your session expired. Sign in again.'}));ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));}throw error;}if(!current())throw Error('Account changed.');return result;};r.api={get:(...args)=>invoke('get',args),request:(...args)=>invoke('request',args)};
  if(this.mutation)ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));
  try{const values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values;await this.perform(r,ctx,{...this.detail,values});}catch(error){publish(r,ctx,{error:error.message||'The request could not be completed. Please try again.'});}finally{if(this.mutation)publish(r,ctx,{busy:false});}
 }
}

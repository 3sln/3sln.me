import {Action} from '../shared/stack.mjs';

const changed=feed=>feed.dispatchEvent(new Event('browser-state-updated'));
const update=(r,ctx,patch)=>{r.state.transition(next=>Object.assign(next,patch));changed(ctx.engineFeed);};

/** Loads the server-derived lifecycle status after a suspended response. */
export async function showLifecycle(r,ctx){
 update(r,ctx,{lifecycle:{required:true}});
 try{const status=await r.api.get('/api/account/lifecycle');update(r,ctx,{lifecycle:{required:Boolean(status.reactivationRequired),phase:status.phase,deadlineDays:status.deadlineDays,deletionScheduled:status.deletionScheduled===true}});}catch{/* The prompt remains with generic wording. */}
}
/** Explicit owner confirmation ("I'm still using it"); reactivation needs a recent sign-in. */
export class ReactivateAccount extends Action {
 static deps={state:{write:true},api:{}};
 async execute(r,ctx){
  if(!r.state.reserve())return;
  try{await r.api.request('/api/account/lifecycle/reactivate',{});update(r,ctx,{lifecycle:null,error:'',notice:'Thanks. Your account is active again.'});const data=await r.api.get('/api/account');update(r,ctx,{data});}
  catch(error){if(error.code==='reauthentication_required')update(r,ctx,{lifecycle:{...r.state.snapshot().lifecycle,reauthenticate:true},error:error.message});else update(r,ctx,{error:error.message});}
  finally{update(r,ctx,{busy:false});}
 }
}

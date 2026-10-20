import {Action} from '../shared/stack.mjs';
// Keep the suspended request and its values outside the public UI projection.
// Resume only this request, once, within the same owner/session incarnation.
const waiting=new WeakMap(),snapshot=r=>r.state.snapshot();
const publish=(r,ctx,patch)=>{r.state.transition(next=>Object.assign(next,patch));ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));};
export function cancelStepUp(browser){const pending=waiting.get(browser);waiting.delete(browser);pending?.reject(Error('Confirmation canceled.'));}
export function freshAPI(r,ctx){const invoke=async(method,args)=>{
 const initial=snapshot(r),owner=initial.session?.account?.id,session=initial.session?.sessionContext,generation=initial.beamGeneration??0;
 const live=()=>snapshot(r).session?.account?.id===owner&&snapshot(r).session?.sessionContext===session&&(snapshot(r).beamGeneration??0)===generation&&!snapshot(r).offline;
 try{return await r.api[method](...args);}catch(error){
  if(error.code!=='reauthentication_required'||args[3]?.dispatchToken||!owner||!live())throw error;
  if(waiting.has(r.browser))throw error;
  const id=crypto.randomUUID(),options=await r.api.request('/api/auth/step-up/begin',{});if(!live())throw Error('Account changed.');
  const confirmed=new Promise((resolve,reject)=>waiting.set(r.browser,{id,live,resolve,reject}));
  const invalidate=()=>{if(live())return;cancelStepUp(r.browser);if(snapshot(r).stepUp?.id===id)publish(r,ctx,{stepUp:null});};ctx.engineFeed.addEventListener('browser-state-updated',invalidate);
  publish(r,ctx,{stepUp:{id,password:options.password===true,passkey:options.passkey===true,authenticationOptions:options.authenticationOptions},busy:false,modal:null,error:'',notice:''});r.browser.focus?.('.step-up h2');
  try{await confirmed;}finally{ctx.engineFeed.removeEventListener('browser-state-updated',invalidate);}if(!live())throw Error('Account changed.');if(!r.state.reserve())throw Error('Please try again.');publish(r,ctx,{});
  return r.api[method](...args);
 }
};return new Proxy(r.api,{get:(target,key)=>['request','get'].includes(key)?(...args)=>invoke(key,args):typeof target[key]==='function'?target[key].bind(target):target[key]});}

export class ConfirmOwner extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 async execute(r,ctx){const pending=waiting.get(r.browser),prompt=snapshot(r).stepUp;if(!pending||pending.id!==prompt?.id||this.detail.id!==prompt.id)return;
  if(!pending.live()){cancelStepUp(r.browser);publish(r,ctx,{stepUp:null});return;}
  if(!r.state.reserve())return;publish(r,ctx,{});let confirmed=false;
  try{const values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values,method=this.detail.method;
   if(method==='password'&&!prompt.password||method==='passkey'&&!prompt.passkey||!['password','passkey'].includes(method))throw Error('Choose a password or passkey to continue.');
   const input=method==='password'?{method,password:values?.password}:{method,response:await r.browser.authenticatePasskey(prompt.authenticationOptions)};
   if(!pending.live()||waiting.get(r.browser)!==pending)return;
   await r.api.request('/api/auth/step-up',input);if(!pending.live()||waiting.get(r.browser)!==pending)return;
   waiting.delete(r.browser);publish(r,ctx,{stepUp:null,error:''});confirmed=true;
  }catch(error){if(pending.live()&&waiting.get(r.browser)===pending)publish(r,ctx,{error:error.message});}
  finally{if(pending.live())publish(r,ctx,{busy:false});if(confirmed)pending.resolve();}
 }
}
export class CancelOwnerConfirmation extends Action {
 static deps={state:{write:true},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 execute(r,ctx){if(snapshot(r).stepUp?.id!==this.detail.id||snapshot(r).busy)return;cancelStepUp(r.browser);publish(r,ctx,{stepUp:null});}
}

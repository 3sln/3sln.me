import assert from 'node:assert/strict';
import {baseURL} from './browser.mjs';
// UI chaos harness. The real local Worker serves the built application; every
// /api request is answered by an explicit, labeled fixture model so faults can be
// injected deterministically at the HTTP boundary: status bursts, truncated or
// non-JSON bodies, connection resets, held (gated) responses released out of
// order, and replies lost after the fixture already applied the change.
export const OWNER_A='11111111-2222-4333-8444-555555555555',OWNER_B='22222222-3333-4444-8555-666666666666';
export const builtinViews=()=>[{id:'all',name:'All messages',builtin:true,revision:1,filter:{version:1},sort:'activity-desc'}];
// Seeded PRNG (mulberry32): every "random" order in these suites is reproducible from its seed.
export function seeded(seed){let a=seed>>>0;const next=()=>{a=a+0x6D2B79F5>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};return {next,pick:list=>list[Math.floor(next()*list.length)],shuffle:list=>{const copy=[...list];for(let i=copy.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;}};}
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// Transport faults. `after` faults first let the fixture apply the request, then lose the reply.
export const FAULTS=[500,503,429,'truncated','non-json','reset'];
async function fault(route,kind){
 if(kind===500||kind===502||kind===503)return route.fulfill({status:kind,json:{error:'unavailable',message:'The service is temporarily unavailable.'}});
 if(kind===429)return route.fulfill({status:429,headers:{'Retry-After':'30'},json:{error:'rate_limited',message:'Please wait before trying again.'}});
 if(kind==='truncated')return route.fulfill({status:200,contentType:'application/json',body:'{"account":{"id":"'});
 if(kind==='non-json')return route.fulfill({status:200,contentType:'text/html',body:'<html><body>Upstream proxy error</body></html>'});
 if(kind==='reset')return route.abort('connectionreset');
 throw new Error('Unknown fault '+kind);
}
// Pending indicators a settled screen must not keep: busy submit labels, aria-busy regions,
// the boot screen and "Loading…" status lines.
const STUCK=()=>[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Please wait…').length+document.querySelectorAll('.boot-screen,[aria-busy=true]').length+[...document.querySelectorAll('[role=status]')].filter(node=>/^(Loading|Cargando)/.test(node.textContent.trim())).length;
/** One browser context whose /api surface is a mutable fixture model. */
export async function chaosConsole(browser,t,{account={id:OWNER_A,handle:'n.chaos',status:'active',hasPassword:true,passkeyCount:0},signedIn=true,config={},data={},views=builtinViews(),incoming={},viewport={width:1440,height:1000},contextOptions={},handlers={},goto='/console'}={}){
 const context=await browser.newContext({viewport,serviceWorkers:'block',...contextOptions});t.after(()=>context.close());
 const model={account,signedIn,config:{environment:'UI chaos fixture',termsVersion:'2026-10-11',localDevelopment:true,signupEnabled:true,providers:{},...config},data:{account,collections:[{id:'inbox',name:'Inbox'}],messages:[],contacts:[],rules:[],resources:[],grants:[],...data},views,incoming,calls:[],faults:[],gates:[],handlers};
 const waiters=new Set(),record=(method,path,body)=>{model.calls.push({method,path,body});for(const waiter of waiters)waiter();};
 const count=(method,path)=>model.calls.filter(call=>call.method===method&&(typeof path==='string'?call.path===path:path.test(call.path))).length;
 const json=route=>{try{return route.request().postDataJSON();}catch{return null;}};
 const answer=async(route,method,path,url)=>{
  const custom=model.handlers[method+' '+path]??Object.entries(model.handlers).find(([key])=>key.startsWith(method+' ^')&&new RegExp(key.slice(method.length+1)).test(path))?.[1];if(custom)return custom(route,{model,url,body:json(route)});
  if(path==='/api/config')return route.fulfill({json:model.config});
  if(path==='/api/session')return route.fulfill({json:model.signedIn?{authenticated:true,account:model.account,csrfToken:'fixture-csrf',sessionContext:'fixture-context'}:{authenticated:false,account:null}});
  if(path==='/api/account'){if(!model.signedIn)return route.fulfill({status:401,json:{error:'unauthorized',message:'Sign in to continue.'}});return route.fulfill({json:{...model.data,account:model.account,views:model.views}});}
  if(path==='/api/views'&&method==='GET')return route.fulfill({json:{views:model.views}});
  if(path==='/api/incoming'&&method==='GET'){const view=url.searchParams.get('view')??'all',items=model.incoming[view]??[],start=Number(url.searchParams.get('cursor')??0),limit=Number(url.searchParams.get('limit')??50),page=items.slice(start,start+limit);return route.fulfill({json:{items:page,cursor:start+limit<items.length?String(start+limit):null,indexRevision:1}});}
  if(path==='/api/auth/login/password'&&method==='POST'){model.signedIn=true;return route.fulfill({json:{account:model.account,csrfToken:'fixture-csrf',sessionContext:'fixture-context'}});}
  return route.fulfill({status:404,json:{error:'not_found',message:'Not found.'}});
 };
 await context.route(url=>new URL(url).pathname.startsWith('/api/'),async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname;record(method,path,json(route));
  const index=model.faults.findIndex(entry=>entry.method===method&&(typeof entry.path==='string'?entry.path===path:entry.path.test(path)));
  if(index>=0){const entry=model.faults[index];if(--entry.times<=0)model.faults.splice(index,1);
   if(entry.kind==='gate'){const gate={route,method,path,released:false};model.gates.push(gate);entry.onHold?.(gate);return;}
   if(entry.after){let applied=false;const proxy={fulfill:async()=>{applied=true;},abort:async()=>{applied=true;},continue:async()=>{applied=true;},request:()=>request};await answer(proxy,method,path,url);assert.ok(applied);return fault(route,entry.kind);}
   return fault(route,entry.kind);}
  return answer(route,method,path,url);
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',error=>errors.push('pageerror: '+error.message));
 // Injected faults legitimately produce resource-load console entries; anything else is an application error.
 page.on('console',message=>{if(message.type()==='error'&&!/^Failed to load resource|net::ERR_|status of (4|5)\d\d/.test(message.text()))errors.push('console: '+message.text());});
 t.after(()=>assert.deepEqual(errors,[],'No browser runtime or console errors'));
 const api={
  context,page,model,errors,count,
  /** Resolves once `n` matching requests reached the network (event-driven, no polling sleeps). */
  requests(method,path,n){return new Promise(resolve=>{const check=()=>{if(count(method,path)>=n){waiters.delete(check);resolve();}};waiters.add(check);check();});},
  /** Queue `times` faults for the next matching requests. */
  inject(method,path,kind,{times=1,after=false}={}){model.faults.push({method,path,kind,times,after});},
  /** Hold the next matching request until release(); resolves when the request reaches the network. */
  hold(method,path){const held=deferred(),timer=setTimeout(()=>held.reject(new Error(`No ${method} ${path} request reached the network`)),10000);model.faults.push({method,path,kind:'gate',times:1,onHold:gate=>{clearTimeout(timer);held.resolve(gate);}});return held.promise;},
  /** Release a held request normally, with a fault, or (after) apply it and then lose the reply. */
  async release(gate,{kind,fulfill,after=false}={}){gate.released=true;const url=new URL(gate.route.request().url());
   if(after){const proxy={fulfill:async()=>{},abort:async()=>{},continue:async()=>{},request:()=>gate.route.request()};await answer(proxy,gate.method,gate.path,url);}
   if(kind)return fault(gate.route,kind).catch(()=>{});if(fulfill)return gate.route.fulfill(fulfill).catch(()=>{});return answer(gate.route,gate.method,gate.path,url).catch(()=>{});},
  /** Settled: no "Please wait…" control, no global boot screen, and no private loading text left behind. */
  // Rendering is coalesced into animation frames, so every DOM check first lets two frames pass.
  frames:()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))),
  async settled(){for(;;){await api.frames();if(await api.stuck()===0)return;await page.waitForFunction(`(${STUCK})()===0`);}},
  /** The busy state must be visible while a held request is pending. */
  async busy(){await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Please wait…'));},
  async stuck(){return page.evaluate(STUCK);},
  alerts:()=>page.locator('[role=alert]').allTextContents(),
  notices:()=>page.locator('.alert.success').allTextContents()
 };
 if(goto){await page.goto(baseURL+goto);await page.locator(signedIn?'.app-shell, .user-summary':'.auth-card, .signup-wizard').first().waitFor();if(signedIn)await page.getByRole('heading',{name:'Messages & conversations'}).waitFor();}
 return api;
}
/** Seeded message rows for the incoming projection. */
export function messages(count,{seed=1,prefix='Message',tags=0,tagLength=8}={}){
 const random=seeded(seed);return Array.from({length:count},(_,index)=>({id:`${String(index).padStart(8,'0')}-1111-4111-8111-${String(seed).padStart(12,'0')}`,type:'message',mimeType:'text/plain',size:64,receivedAt:1790000000000-index*60000,activityAt:1790000000000-index*60000,readAt:random.next()<0.5?1790000000000:null,subject:`${prefix} ${index}`,organizationRevision:1,tags:Array.from({length:tags},(_,tag)=>('t'+tag+'-').padEnd(tagLength,'x'))}));
}

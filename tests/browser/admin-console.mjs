import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const window=new Window({url:'https://host.example/console?boot'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData','HTMLInputElement'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const {dodo,Engine,Provider}=await import('../../apps/web/src/shared/stack.mjs');
const {createLocalization}=await import('../../apps/web/src/shared/i18n.mjs');
const {default:localizeTree}=await import('../../apps/web/src/ui/localize.mjs');
const {createAdminAPI}=await import('../../apps/web/src/providers/admin-api.mjs');
const {parseBootToken,adminRoute}=await import('../../apps/web/src/providers/admin-browser.mjs');
const {default:AdminStateProvider,initialAdminState}=await import('../../apps/web/src/providers/admin-state.mjs');
const access=await import('../../apps/web/src/bl/admin-access.mjs');
const ops=await import('../../apps/web/src/bl/admin-console.mjs');
const {accessView}=await import('../../apps/web/src/ui/admin-access.mjs');
const {consoleView}=await import('../../apps/web/src/ui/admin-console.mjs');
const origin='https://host.example',owner='550e8400-e29b-41d4-a716-446655440001',nonce='6f1c2a7e-1111-4222-8333-944455556666',now=1792000000000;
const catalog={version:1,capabilities:{'support.read':{class:'user',description:'Read support tickets.'},'ops.danger':{class:'internal',description:'Dangerous operations.'},'desk.read':{class:'internal',description:'Help desk.'}},roles:{support:{class:'user',name:'Support',description:'Support staff.',capabilities:['support.read']},ops:{class:'internal',name:'Ops',description:'Operations.',capabilities:['ops.danger']},desk:{class:'internal',name:'Desk',description:'Help desk.',capabilities:['desk.read'],delegable:true}},badgeClasses:{beta:'user',staff:'delegable'}};
const overview=(extra={})=>({actor:{kind:'admin',owner},boot:{status:'active',generation:2,claimedAt:now-86400000,restoredAt:now-3600000,expiresAt:now+7200000,tokenDigest:'abcdef012345',methods:['password'],active:true},catalog,catalogRevision:3,badges:[{id:'system',class:'internal'},{id:'beta',class:'user'},{id:'staff',class:'delegable'}],reservations:{static:['ray','security'],runtime:[{name:'night-desk',source:'runtime',roles:['desk'],badgeIds:[],createdAt:now,updatedAt:now}]},claims:[{nonce,name:'night-desk',state:'issued',roles:['desk'],badgeIds:[],expiresAt:now+3600000,createdAt:now,linkAvailable:true}],audit:{seq:12},...extra});
const user=(extra={})=>({id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',handle:'n.4x2',aliases:['n.4x2'],status:'active',createdAt:now,lastActiveAt:now,badgeIds:[],internal:false,provenance:null,roles:['support'],authority:{roles:['support'],capabilities:['support.read'],admin:false},email:'p***@example.org',principalRevision:1,suspendedByAdmin:false,...extra});
async function fixture({mode='boot',state={},api:handlers={}}={}){
 const calls=[],secrets=new Map(),focus=[],nav=[];let clock=now;
 const api={generation:0,csrf:null,hasBootCsrf(){return Boolean(this.csrf);},setBootCsrf(v){this.csrf=v;},forget(){this.generation++;this.csrf=null;calls.push({path:'forget'});},accountSession:async()=>handlers.session??{id:owner,handle:'ops'},call:async(actor,path,body)=>{calls.push({actor,path,body});const handler=handlers[path];if(!handler)throw Object.assign(new Error(path),{code:'not_mocked'});return typeof handler==='function'?handler(body,actor):handler;}};
 const browser={route:()=>({mode}),origin:()=>origin,now:()=>clock,language:()=>'en',applyLocale(){},setTitle(){},every:()=>()=>{},secret:k=>secrets.get(k)??null,storeSecret:(k,v)=>v==null?secrets.delete(k):secrets.set(k,v),clearSecrets:()=>secrets.clear(),readTokenFile:async file=>file.text(),createPasskey:async()=>({id:'cred',response:{}}),authenticatePasskey:async()=>({id:'cred',response:{}}),copy:async()=>{},navigate:u=>nav.push(u),rememberFocus(){},restoreFocus(){focus.push('restore');},focus:s=>focus.push(s)};
 const events=[];const engine=new Engine({providers:{api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),state:class extends AdminStateProvider{constructor(){super(initialAdminState({mode,now,...state}));}}}});
 engine.feed.addEventListener('admin-retry',event=>events.push(event.detail));
 const snapshot=await engine.container.use(['state'],({state})=>state.snapshot),read=()=>snapshot();
 return {engine,api,browser,secrets,calls,events,focus,nav,read,act:action=>engine.dispatch(action).next('complete'),tick:ms=>{clock+=ms;},close:()=>engine.dispose()};
}
function render(view,state,locale='en'){const root=document.createElement('div');const missing=new Set();const localization=createLocalization({locale,onMissing:(scope,id)=>missing.add(id)});dodo.reconcile(root,[localizeTree(view(state),localization)]);return {root,missing};}
const state=(patch={})=>({...initialAdminState({phase:'console',mode:'boot',now,locale:'en',boot:{bootExpiresAt:now+7200000,sessionExpiresAt:now+1800000,stepUpUntil:now+300000},consoleReady:true,overview:overview()}),...patch});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('admin transport: explicit actor, in-memory CSRF only, POST bodies, and stale answers dropped after reset',async t=>{
 const calls=[];const fetch=async(path,options)=>{calls.push({path,options});return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});};
 const account={captureContext:()=>({owner,sessionContext:'ctx',csrfToken:'account-csrf'}),clearContext(){},get:async()=>({}),setContext(){}};
 const api=createAdminAPI({fetch,account});api.setBootCsrf('b'.repeat(43));
 await api.call('boot','/api/admin/overview',{});await api.call('admin','/api/admin/overview',{});
 assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.headers['X-Bindle-Admin-Actor'],'boot');assert.equal(calls[0].options.headers['X-CSRF-Token'],'b'.repeat(43));assert.equal(calls[0].options.headers['X-Bindle-Account'],undefined);assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.referrerPolicy,'no-referrer');
 assert.equal(calls[1].options.headers['X-Bindle-Admin-Actor'],'admin');assert.equal(calls[1].options.headers['X-CSRF-Token'],'account-csrf');assert.equal(calls[1].options.headers['X-Bindle-Account'],owner);
 await assert.rejects(api.call('root','/api/admin/overview'),{code:'actor_required'});await assert.rejects(api.call('boot','/api/account'),{code:'invalid_request'});await assert.rejects(api.call('boot','/api/admin/x?token=1'),{code:'invalid_request'});
 const wait=deferred();const slow=createAdminAPI({fetch:()=>wait.promise,account});const pending=slow.call('boot','/api/admin/overview',{});slow.forget();wait.resolve(new Response('{"secret":1}',{headers:{'content-type':'application/json'}}));await assert.rejects(pending,{code:'local_reset'});
 const failing=createAdminAPI({fetch:async()=>new Response(JSON.stringify({error:'step_up_required',message:'x'}),{status:403,headers:{'content-type':'application/json'}}),account});await assert.rejects(failing.call('admin','/api/admin/overview'),e=>e.code==='step_up_required'&&e.status===403);
 assert.equal(adminRoute({search:'?boot'}).mode,'boot');assert.equal(adminRoute({search:'?admin'}).mode,'admin');
});
test('boot token parsing gives clear local errors for wrong origin, stale file, malformed text',()=>{
 const claims=btoa(JSON.stringify({v:1,iss:origin,purpose:'boot',ts:now,nonce:'n'.repeat(22),secret:'s'.repeat(43)})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),token='boot1.'+claims;
 assert.equal(parseBootToken(token,{origin,now}),token);assert.equal(parseBootToken(JSON.stringify({format:'bindle-boot-token/v1',issuer:origin,usableUntil:now+1,token}),{origin,now}),token);
 assert.throws(()=>parseBootToken(token,{origin:'https://other.example',now}),{code:'token_wrong_origin'});
 assert.throws(()=>parseBootToken(JSON.stringify({format:'bindle-boot-token/v1',issuer:origin,usableUntil:now-1,token}),{origin,now}),{code:'token_stale'});
 assert.throws(()=>parseBootToken('{"format":"x"}',{origin,now}),{code:'token_file_invalid'});assert.throws(()=>parseBootToken('hello',{origin,now}),{code:'token_malformed'});assert.throws(()=>parseBootToken('',{origin,now}),{code:'token_missing'});
});
const goodToken='boot1.'+btoa(JSON.stringify({v:1,iss:origin,purpose:'boot',ts:now,nonce:'n'.repeat(22),secret:'s'.repeat(43)})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
test('boot setup keeps the token out of state, requires the expiry acknowledgement and lands in the console',async()=>{
 const f=await fixture({api:{'/api/admin/boot/session':()=>{throw Object.assign(Error('x'),{code:'unauthorized'});},'/api/admin/boot/status':{configured:true,token:'unused'},'/api/admin/boot/begin':{ready:true},'/api/admin/boot/start':{mode:'claim',registrationOptions:{challenge:'c'},completeBy:now+600000,accessMs:86400000},'/api/admin/boot/complete':{mode:'claim',csrfToken:'c'.repeat(43),sessionExpiresAt:now+3600000,bootExpiresAt:now+86400000}}});
 try{await f.act(new access.InitializeAdmin());assert.equal(f.read().phase,'boot-setup');
  await f.act(new access.BootStart({values:{token:goodToken}}));assert.equal(f.read().setup.mode,'claim');assert.equal(JSON.stringify(f.read()).includes(goodToken),false);assert.equal(f.secrets.get('bootToken'),goodToken);
  await f.act(new access.BootMethod({method:'password'}));await f.act(new access.BootComplete({values:{password:'a long boot password',confirm:'a long boot password'}}));assert.equal(f.read().error.code,'acknowledgement_required');assert.equal(f.calls.some(c=>c.path==='/api/admin/boot/complete'),false);
  await f.act(new access.BootComplete({values:{password:'a long boot password',confirm:'different password!!',acknowledge:'on'}}));assert.equal(f.read().error.code,'password_mismatch');
  await f.act(new access.BootComplete({values:{password:'a long boot password',confirm:'a long boot password',acknowledge:'on'}}));
  const complete=f.calls.find(c=>c.path==='/api/admin/boot/complete');assert.equal(complete.body.acknowledgeExpiry,true);assert.equal(complete.body.bootToken,goodToken);
  assert.equal(f.read().phase,'console');assert.equal(f.read().boot.bootExpiresAt,now+86400000);assert.equal(f.api.csrf,'c'.repeat(43));assert.equal(f.secrets.has('bootToken'),false);assert.equal(f.read().notice,'claimed');
 }finally{f.close();}
});
test('consumed token, wrong origin and closed setup window show clear errors and burn local secrets',async()=>{
 const f=await fixture({api:{'/api/admin/boot/begin':{ready:true},'/api/admin/boot/start':()=>{throw Object.assign(Error('x'),{code:'boot_token_consumed',status:409});}}});
 try{await f.act(new access.BootStart({values:{token:goodToken}}));assert.equal(f.read().error.code,'boot_token_consumed');assert.equal(f.read().tokenState,'used');assert.equal(f.secrets.has('bootToken'),false);
  await f.act(new access.BootStart({values:{token:goodToken.replace('host.example','evil.example')}}));
  f.api.call=async(a,path)=>{if(path.endsWith('/start'))return {mode:'restore',completeBy:now+1000,accessMs:3600000};return {};};await f.act(new access.BootStart({values:{token:goodToken}}));assert.equal(f.read().setup.mode,'restore');f.tick(2000);await f.act(new access.Tick());assert.equal(f.read().setup,null);assert.equal(f.read().error.code,'setup_expired');assert.equal(f.secrets.has('bootToken'),false);
 }finally{f.close();}
});
test('boot expiry and session expiry wipe every privileged datum locally, even without a request',async()=>{
 const f=await fixture({state:{phase:'console',consoleReady:true,boot:{bootExpiresAt:now+5000,sessionExpiresAt:now+60000,stepUpUntil:now},overview:overview(),user:user(),reveal:{link:'https://host.example/token-onboarding#token=x'},audit:{entries:[]}}});
 try{f.tick(6000);await f.act(new access.Tick());const s=f.read();assert.equal(s.phase,'boot-expired');for(const key of ['overview','user','reveal','audit','boot','modal'])assert.equal(s[key],null,key);assert.ok(f.calls.some(c=>c.path==='forget'));}finally{f.close();}
 const g=await fixture({state:{phase:'console',boot:{bootExpiresAt:now+86400000,sessionExpiresAt:now+1000,stepUpUntil:now},overview:overview()}});
 try{g.tick(2000);await g.act(new access.Tick());assert.equal(g.read().phase,'boot-signin');assert.equal(g.read().overview,null);assert.equal(g.read().error.code,'session_expired');}finally{g.close();}
});
test('administrator gate: ordinary accounts are denied without console data; admins enter',async()=>{
 const denied=await fixture({mode:'admin',api:{'/api/admin/access':{admin:false}}});try{await denied.act(new access.InitializeAdmin());assert.equal(denied.read().phase,'admin-denied');assert.equal(denied.read().overview,null);}finally{denied.close();}
 const anon=await fixture({mode:'admin',api:{session:null}});anon.api.accountSession=async()=>null;try{await anon.act(new access.InitializeAdmin());assert.equal(anon.read().phase,'admin-signin');}finally{anon.close();}
 const ok=await fixture({mode:'admin',api:{'/api/admin/access':{admin:true,handle:'ops',passkey:true}}});try{await ok.act(new access.InitializeAdmin());assert.equal(ok.read().phase,'console');assert.deepEqual(ok.read().account,{id:owner,handle:'ops',passkey:true});}finally{ok.close();}
 const missing=await fixture({mode:'admin',api:{'/api/admin/access':()=>{throw Object.assign(Error('x'),{code:'not_found',status:404});}}});try{await missing.act(new access.InitializeAdmin());assert.equal(missing.read().phase,'unavailable');}finally{missing.close();}
});
test('step-up: a demand opens the passkey-only admin modal, a wrong credential re-arms it, success retries once',async()=>{
 let stepped=false;const f=await fixture({mode:'admin',state:{phase:'console',account:{id:owner,handle:'ops',passkey:true}},api:{'/api/admin/overview':()=>{if(!stepped)throw Object.assign(Error('x'),{code:'step_up_required',status:403});return overview();},'/api/admin/step-up/begin':{passkey:true,password:true,authenticationOptions:{challenge:'a'}},'/api/admin/step-up':()=>{if(!f.fail){stepped=true;return {stepUpUntil:now+300000};}throw Object.assign(Error('x'),{code:'unauthorized',status:401});}}});
 try{await f.act(new ops.LoadOverview({kind:'reload-overview'}));const modal=f.read().modal;assert.equal(modal.kind,'step-up');assert.deepEqual(modal.methods,{password:false,passkey:true});assert.equal(modal.retry.kind,'reload-overview');
  f.fail=true;await f.act(new ops.StepUpConfirm({method:'passkey'}));assert.equal(f.read().phase,'console','a wrong credential is not a lost session');assert.equal(f.read().modal.error.code,'step_up_failed');
  f.fail=false;await f.act(new ops.StepUpConfirm({method:'passkey'}));assert.equal(f.read().modal,null);assert.deepEqual(f.events.at(-1),{kind:'reload-overview'});
  const sent=f.calls.filter(c=>c.path==='/api/admin/step-up');assert.ok(sent.every(c=>c.body.method==='passkey'));
  await f.act(new ops.StepUpConfirm({method:'password',values:{password:'x'}}));assert.equal(f.calls.filter(c=>c.path==='/api/admin/step-up').length,sent.length,'no password step-up for administrators without an open modal');
 }finally{f.close();}
});
test('a lost session or authority during an operation wipes console data; other failures clear only the requested result',async()=>{
 const f=await fixture({mode:'admin',state:{phase:'console',overview:overview(),user:user(),reveal:{link:'x'}},api:{'/api/admin/users/lookup':()=>{throw Object.assign(Error('x'),{code:'rate_limited',status:429});}}});
 try{await f.act(new ops.Lookup({values:{by:'handle',query:'n.4x2'}}));assert.equal(f.read().user,null);assert.ok(f.read().overview);assert.equal(f.read().error.code,'rate_limited');
  f.api.call=async()=>{throw Object.assign(Error('x'),{code:'forbidden',status:403});};await f.act(new ops.LoadOverview({}));const s=f.read();assert.equal(s.phase,'admin-denied');assert.equal(s.overview,null);assert.equal(s.reveal,null);
 }finally{f.close();}
 const g=await fixture({state:{phase:'console',overview:overview()},api:{'/api/admin/overview':()=>{throw Object.assign(Error('x'),{code:'unauthorized',status:401});},'/api/admin/boot/login/begin':{password:true,passkey:false}}});
 try{await g.act(new ops.LoadOverview({}));assert.equal(g.read().phase,'boot-signin');assert.equal(g.read().overview,null);assert.deepEqual(g.read().signin,{password:true,passkey:false});}finally{g.close();}
});
test('destructive operations require an explicit confirmation before any request',async()=>{
 const f=await fixture({state:{phase:'console',overview:overview(),user:user()},api:{'/api/admin/claims/revoke':{revoked:true},'/api/admin/overview':overview(),'/api/admin/users/suspend':{user:user({status:'suspended',suspendedByAdmin:true})},'/api/admin/boot/end':{ended:true}}});
 try{for(const action of [new ops.RevokeClaim({kind:'revoke-claim',nonce,name:'night-desk'}),new ops.Unreserve({kind:'unreserve',name:'night-desk'}),new ops.Suspend({kind:'suspend',owner:user().id}),new ops.DeleteRole({kind:'delete-role',id:'support'}),new ops.EndBoot({kind:'end-boot'})]){await f.act(action);assert.equal(f.read().modal.kind,'confirm');assert.equal(f.read().modal.intent.confirmed,true);assert.equal(f.calls.filter(c=>c.path!=='forget').length,0);}
  await f.act(new ops.RevokeClaim({kind:'revoke-claim',nonce,name:'night-desk',confirmed:true}));assert.equal(f.calls[0].path,'/api/admin/claims/revoke');assert.equal(f.read().modal,null);
  await f.act(new ops.EndBoot({confirmed:true}));assert.equal(f.read().phase,'boot-ended');assert.equal(f.read().overview,null);
 }finally{f.close();}
 const g=await fixture({state:{phase:'console',overview:overview(),user:user()},api:{'/api/admin/users/roles':{user:user({roles:['admin']})}}});
 try{await g.act(new ops.SetRoles({kind:'set-roles',owner:user().id,values:{roles:['admin','support']}}));assert.equal(g.read().modal.title,'Grant administrator authority?');assert.equal(g.calls.length,0);}finally{g.close();}
});
test('claim links are revealed once, validated to this origin and dropped on navigation',async()=>{
 const f=await fixture({state:{phase:'console',overview:overview()},api:{'/api/admin/claims/mint':{name:'night-desk',nonce,expiresAt:now+3600000,link:origin+'/token-onboarding#token=bo1.x'},'/api/admin/overview':overview(),'/api/admin/claims/link':{name:'x',nonce,link:'https://evil.example/token-onboarding#token=x'}}});
 try{await f.act(new ops.MintClaim({values:{name:'night-desk',hours:'24'}}));assert.equal(f.read().reveal.link,origin+'/token-onboarding#token=bo1.x');assert.deepEqual(f.calls.find(c=>c.path==='/api/admin/claims/mint').body,{name:'night-desk',hours:24});
  await f.act(new ops.Navigate({view:'overview'}));assert.equal(f.read().reveal,null);
  await f.act(new ops.ClaimLink({nonce}));assert.equal(f.read().reveal,null);assert.equal(f.read().error.code,'unexpected_response');
 }finally{f.close();}
});
test('option helpers mirror the class rules: administrators never get boot-only or self/admin-target edits',()=>{
 const target={internal:true,roles:[]},adminOptions=Object.fromEntries(ops.roleOptions('admin',catalog,target).map(o=>[o.id,o]));
 assert.equal(adminOptions.admin.reason,'boot-only');assert.equal(adminOptions.ops.reason,'boot-only');assert.equal(adminOptions.desk.disabled,false);assert.equal(adminOptions.support.disabled,false);
 assert.ok(ops.roleOptions('boot',catalog,target).every(o=>!o.disabled));
 assert.deepEqual(ops.roleOptions('boot',catalog,{internal:false,roles:[]}).map(o=>o.id),['support'],'ordinary targets see only user-class roles');
 assert.ok(ops.roleOptions('admin',catalog,{internal:true,roles:[],self:true}).every(o=>o.reason==='self'));
 assert.ok(ops.roleOptions('admin',catalog,{internal:true,roles:['admin']}).every(o=>o.reason==='admin-target'));
 assert.equal(ops.roleOptions('admin',catalog,{internal:true,roles:['ops']}).find(o=>o.id==='ops').disabled,false,'a held internal role can still be removed');
 const badges=Object.fromEntries(ops.badgeOptions('admin',catalog,overview().badges,{internal:true,badgeIds:[]}).map(o=>[o.id,o]));assert.equal(badges.system.reason,'boot-only');assert.equal(badges.staff.disabled,false);
 assert.deepEqual(ops.badgeOptions('boot',catalog,overview().badges,{internal:false,badgeIds:[]}).map(o=>o.id),['beta']);
 assert.equal(ops.catalogEditable('admin',{class:'internal'}),false);assert.equal(ops.catalogEditable('admin',{class:'user'}),true);
 assert.deepEqual(ops.auditDiff({a:1,b:2},{a:1,b:3}),[{key:'b',before:'2',after:'3'}]);
});
const fullState=(mode,view,extra={})=>state({mode,view,account:{id:owner,handle:'ops',passkey:true},user:user(),principals:{rows:[{owner,roles:['admin'],hold:true,updatedAt:now}],next:owner,cursor:owner,trail:['']},audit:{entries:[{seq:1,at:now,actor:{kind:'token',digest:'abc'},action:'boot.claim',target:'boot',before:null,after:{status:'active'}},{seq:2,at:now,actor:{kind:'admin',owner,handle:'ops'},action:'roles.set',target:owner,before:['a'],after:['b'],phase:'failed'}],head:60,verified:{valid:true,seq:2},fromSeq:2,full:true},overview:overview({claims:[...overview().claims,{nonce:'a',name:'old',state:'revoked',roles:[],badgeIds:[],expiresAt:now+1,createdAt:now},{nonce:'b',name:'late',state:'issued',roles:[],badgeIds:[],expiresAt:now-1,createdAt:now,linkAvailable:false},{nonce:'c',name:'mine',state:'issuing',roles:[],badgeIds:[],expiresAt:now+5,createdAt:now,linkAvailable:false}]}),...extra});
test('every screen renders, is fully translated into Spanish and keeps owner data untranslated',()=>{
 const states=[];for(const phase of ['loading','boot-setup','boot-signin','boot-expired','boot-ended','boot-unconfigured','admin-signin','admin-denied','unavailable','left'])states.push([accessView,state({phase,signin:{password:true,passkey:true},tokenState:'reserved',error:{code:'token_wrong_origin',issuer:'https://x.example'}})]);
 for(const method of ['passkey','password'])states.push([accessView,state({phase:'boot-setup',setup:{mode:'claim',completeBy:now+500000,accessMs:86400000,method}})]);
 for(const mode of ['boot','admin'])for(const view of ['overview','reservations','claims','roles','users','clients','audit']){states.push([consoleView,fullState(mode,view,{clientBlocks:{rows:[{host:'spam.example',reason:'Phishing reports',blockedAt:now,updatedAt:now}],next:null},reveal:{name:'night-desk',nonce,link:origin+'/token-onboarding#token=abc',expiresAt:now,copied:true},notice:'catalog-saved',noticeSubject:'x'})]);states.push([consoleView,fullState(mode,view,{overview:null,audit:null,principals:null,clientBlocks:view==='clients'?{rows:[],next:null}:null,user:null,lookupQuery:{by:'handle',found:false}})]);}
 states.push([consoleView,fullState('admin','users',{user:user({id:owner,roles:['admin'],status:'suspended',suspendedByAdmin:true,internal:true,provenance:'claim'})})]);
 states.push([consoleView,fullState('admin','overview',{overview:overview({boot:{...overview().boot,active:false,status:'ended'}})})]);
 for(const kind of ['step-up','confirm','role','capability'])for(const mode of ['boot','admin'])for(const passkey of [true,false])states.push([consoleView,state({mode,modal:{kind,methods:{password:true,passkey},title:'Delete this role?',body:'Holders lose its capabilities immediately. Their stored role entry stays but grants nothing.',confirmLabel:'Delete role',subject:'support',intent:{kind:'delete-role',id:'support',confirmed:true},id:kind==='role'&&passkey?'support':null,error:{code:'step_up_failed'}}})]);
 const missing=new Set();for(const [view,s] of states){const {root,missing:m}=render(view,s,'es');for(const k of m)missing.add(k);for(const node of root.querySelectorAll('[translate=no]'))assert.equal(node.closest('[translate=no]'),node.closest('[translate=no]'));}
 assert.deepEqual([...missing].filter(k=>k.trim()&&k!=='—'),[]);
 for(const [code,text] of Object.entries(errorTexts()))assert.notEqual(createLocalization({locale:'es'}).t(text),text,code);
});
let errorTexts;{const mod=await import('../../apps/web/src/ui/admin-access.mjs');errorTexts=()=>({...mod.ERRORS,...mod.NOTICES});}
test('boot-only controls are visibly distinct and disabled for administrators; actions are keyboard-operable buttons',()=>{
 const admin=render(consoleView,fullState('admin','roles')).root,boot=render(consoleView,fullState('boot','roles')).root;
 assert.ok(admin.querySelectorAll('.boot-only-zone.locked').length>=2);assert.ok(admin.querySelectorAll('.boot-only-mark').length>=2);
 assert.ok([...admin.querySelectorAll('.boot-only-zone select')].every(node=>node.disabled));assert.ok([...boot.querySelectorAll('.boot-only-zone select')].every(node=>!node.disabled));
 assert.equal([...admin.querySelectorAll('button')].some(b=>b.textContent.includes('Add capability')),false);assert.ok([...boot.querySelectorAll('button')].some(b=>b.textContent.includes('Add capability')));
 const users=render(consoleView,fullState('admin','users',{user:user({id:owner})})).root;assert.ok([...users.querySelectorAll('#lookup-result button[type=submit]')].every(b=>b.disabled),'own account is read-only');assert.match(users.textContent,/This is your own account/);
 const nav=render(consoleView,fullState('boot','claims')).root.querySelector('nav.admin-nav');assert.equal(nav.getAttribute('aria-label'),'Administration sections');assert.equal(nav.querySelector('[aria-current=page]').textContent,'Claims');assert.ok([...nav.querySelectorAll('button')].every(b=>b.type==='button'));
 const banner=render(consoleView,fullState('boot','overview')).root.querySelector('.boot-banner');assert.equal(banner.getAttribute('role'),'timer');assert.match(banner.textContent,/Boot access ends in 2 h 00 min/);
 const critical=render(consoleView,fullState('boot','overview',{boot:{bootExpiresAt:now+300000,sessionExpiresAt:now+300000,stepUpUntil:now}})).root.querySelector('.boot-banner');assert.ok(critical.classList.contains('critical'));
 const modal=render(consoleView,state({modal:{kind:'confirm',title:'Delete this role?',body:'x',confirmLabel:'Delete role',intent:{kind:'delete-role'}}})).root;assert.equal(modal.querySelector('[role=alertdialog]').getAttribute('aria-modal'),'true');assert.equal(modal.querySelector('.admin-console').inert,true);
 const setup=render(accessView,state({phase:'boot-setup'})).root;assert.equal(setup.querySelector('form').getAttribute('method'),'post');assert.equal(setup.querySelector('textarea[name=token]').getAttribute('autocomplete'),'off');
});
test('the ordinary console graph never imports administration modules; main loads them only on ?boot/?admin',async()=>{
 const seen=new Set(),queue=['apps/web/src/release.mjs'];const root=new URL('../../',import.meta.url);
 while(queue.length){const file=queue.pop();if(seen.has(file))continue;seen.add(file);const text=await readFile(new URL(file,root),'utf8');for(const [,spec] of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g).map(m=>[m[0],m[1]??m[2]])){if(!spec||!spec.startsWith('.'))continue;const next=new URL(spec,new URL(file,root)).pathname.slice(new URL(root).pathname.length);if(next.startsWith('apps/web/src/'))queue.push(next);}}
 assert.equal([...seen].some(file=>/admin-/.test(file)),false);
 const main=await readFile(new URL('apps/web/src/main.mjs',root),'utf8');assert.match(main,/adminQuery\.has\('boot'\) \|\| adminQuery\.has\('admin'\)/);
 const entry=await readFile(new URL('apps/web/src/admin-entry.mjs',root),'utf8');assert.equal(/import\s[^(]*from\s*['"]\.\/(?:admin-console|ui\/admin-console|bl\/admin-console)/.test(entry),false,'operations load only via dynamic import');assert.match(entry,/import\('\.\/admin-console\.mjs'\)/);
});
test('review fixes: unconfirmed boot logout is reported, admin data expires locally, nav is blocked while busy',async()=>{
 const f=await fixture({state:{phase:'console',overview:overview(),boot:{bootExpiresAt:now+86400000,sessionExpiresAt:now+3600000,stepUpUntil:now}},api:{'/api/admin/boot/logout':()=>{throw Object.assign(Error('x'),{code:'conflict',status:409});},'/api/admin/boot/login/begin':{password:true,passkey:false}}});
 try{f.api.csrf='c';await f.act(new access.SignOut());assert.equal(f.read().phase,'boot-signin');assert.equal(f.read().error.code,'logout_unconfirmed');assert.equal(f.read().notice,'');assert.equal(f.read().overview,null);}finally{f.close();}
 const g=await fixture({mode:'admin',state:{phase:'console',consoleReady:true,stepUpAt:now,overview:overview(),user:user(),reveal:{link:'x'}}});
 try{g.tick(900001);await g.act(new access.Tick());const s=g.read();assert.equal(s.phase,'console');assert.equal(s.consoleReady,false);assert.equal(s.overview,null);assert.equal(s.user,null);assert.equal(s.reveal,null);}finally{g.close();}
 const h=await fixture({state:{phase:'console',busy:true,view:'claims',reveal:{link:'x'}}});try{await h.act(new ops.Navigate({view:'overview'}));assert.equal(h.read().view,'claims');assert.ok(h.read().reveal);}finally{h.close();}
 const a=await fixture({mode:'admin',state:{phase:'console'},api:{'/api/admin/step-up/end':{ended:true}}});try{await a.act(new access.SignOut());assert.ok(a.calls.some(c=>c.path==='/api/admin/step-up/end'));assert.deepEqual(a.nav,['/console']);}finally{a.close();}
});
test('a redeemed claim shows its redemption time, is not outstanding and offers no revoke or link action',()=>{
 const claims=[{nonce,name:'night-desk',state:'issued',roles:['desk'],badgeIds:[],expiresAt:now+3600000,createdAt:now-7200000,redeemedAt:now-60000,linkAvailable:true}];
 for(const locale of ['en','es']){
  const {root,missing}=render(consoleView,fullState('boot','claims',{overview:overview({claims})}),locale),text=root.textContent;
  assert.match(text,locale==='es'?/Canjeado el /:/Redeemed /);assert.doesNotMatch(text,locale==='es'?/Pendiente/:/Outstanding/);
  assert.equal([...root.querySelectorAll('button')].some(b=>/Revoke|Revocar|Retrieve link|Recuperar/.test(b.textContent)),false);
  assert.deepEqual([...missing].filter(k=>/Redeemed/.test(k)),[]);
  const summary=render(consoleView,fullState('boot','overview',{overview:overview({claims})}),locale).root.textContent;
  assert.match(summary,locale==='es'?/No hay reclamaciones pendientes|0/:/No outstanding claims\./);
 }
});

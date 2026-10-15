// UI-state checks for the provider-owned authorization entry page (slice A7): real dodo/ngin/bab modules in
// happy-dom with a scripted same-origin server and a substituted browser provider (window, opener, navigation).
// Real-browser coverage against the local Worker lives in tests/e2e/authorization-entry-ui.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://provider.example/oauth/authorize?entry='+'E'.repeat(43)}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData','HTMLInputElement','MouseEvent'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const entryLogic=await import('../../apps/web/src/bl/authorize-entry.mjs');
const {parseEntryLocation,validEntryView,entryToken,priorApproval,callbackTarget,eligibleAccounts,parseAccounts,durationOf}=entryLogic;
const {embedOriginFor,validProof,validAck,runHandshake,deliverToOpener}=await import('../../apps/web/src/bl/authorize-entry-embed.mjs');
const {createArming}=await import('../../apps/web/src/bl/authorize-entry-arming.mjs');
const {startEntryPage}=await import('../../apps/web/src/bl/authorize-entry-page.mjs');
const {authorizeCatalogue,authorizeLocalization}=await import('../../packages/i18n/authorize-catalogue.mjs');
const issuer='https://provider.example',embed='https://embed.provider.example',app='https://app.example',entryId='E'.repeat(43),nonce='N'.repeat(22);
const A='550e8400-e29b-41d4-a716-446655440001',B='550e8400-e29b-41d4-a716-446655440002';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pageToken='T'.repeat(43),view=(overrides={})=>({entry:{client:{id:app+'/client',name:'Example app',origin:app},redirectUri:app+'/callback',intent:'login',requests:[],presentation:'popup',delivery:'popup',nonce,expiresAt:Date.now()+600000,...overrides},pageToken});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test('location, entry view, callback and inventory validation fail closed',()=>{
 assert.deepEqual(parseEntryLocation({pathname:'/oauth/authorize',search:'?entry='+entryId}),{entryId,plain:false});
 assert.deepEqual(parseEntryLocation({pathname:'/oauth/authorize',search:`?entry=${entryId}&mode=plain`}),{entryId,plain:true});
 for(const search of ['?entry=short',`?entry=${entryId}&entry=${entryId}`,`?entry=${entryId}&mode=embed`,`?entry=${entryId}&request_id=x`,''])assert.equal(parseEntryLocation({pathname:'/oauth/authorize',search}),null,search);
 assert.equal(parseEntryLocation({pathname:'/oauth/other',search:'?entry='+entryId}),null);
 const entry=validEntryView(view(),issuer);assert.equal(entry.client.origin,app);assert.equal(entry.intent,'login');
 assert.throws(()=>validEntryView(view({redirectUri:'https://evil.example/callback'}),issuer),/not valid/);
 assert.throws(()=>validEntryView(view({intent:'admin'}),issuer));assert.throws(()=>validEntryView({entry:{...view().entry,extra:1}},issuer));assert.throws(()=>validEntryView({...view(),extra:1},issuer));
 assert.equal(entryToken(view()),pageToken);assert.throws(()=>entryToken({...view(),pageToken:'short'}),/not valid/);assert.throws(()=>entryToken({entry:view().entry}),'the page token is required');
 const requested=[{fragment:'https://schema.example/s/v1',required:true,purpose:'x',fields:['theme']}],prior=[{fragment:'https://schema.example/s/v1',fields:['theme'],revision:'r1',resources:{},methods:{}}];
 assert.deepEqual(priorApproval(prior,requested),prior);for(const bad of [null,[],[{...prior[0],fields:['other']}],[{...prior[0],fragment:'https://x.example/v1'}],[{...prior[0],extra:1}],[{...prior[0],revision:1}],[...prior,...prior]])assert.equal(priorApproval(bad,requested),null,JSON.stringify(bad));
 assert.throws(()=>validEntryView(view({intent:'reauthenticate',subjectConstraint:`${issuer}/entities/${A}`}),issuer),'reauthenticate needs maxAge');
 assert.throws(()=>validEntryView(view({intent:'end-session',subjectConstraint:`https://other.example/entities/${A}`}),issuer));
 assert.equal(validEntryView(view({intent:'end-session',subjectConstraint:`${issuer}/entities/${A}`}),issuer).subjectOwner,A);
 assert.equal(callbackTarget(app+'/callback?code=c&state=s&iss='+encodeURIComponent(issuer),app+'/callback',issuer,['code','state','iss']).searchParams.get('code'),'c');
 for(const bad of [app+'/other?code=c','https://evil.example/callback?code=c',app+'/callback?code=c#x',app+'/callback?code=c&code=d',app+'/callback?code=c&token=t',app+'/callback?iss=https%3A%2F%2Fevil.example','https://u:p@app.example/callback'])assert.throws(()=>callbackTarget(bad,app+'/callback',issuer,['code','state','iss']),/callback/,bad);
 assert.throws(()=>callbackTarget(app+'/callback?code=c',app+'/callback',issuer,['result','state','iss']),'end-session callbacks never carry a code');
 assert.throws(()=>callbackTarget('javascript:alert(1)','javascript:alert(1)',issuer,[]),/callback/,'opaque-origin schemes never match themselves');assert.throws(()=>validEntryView(view({redirectUri:'http://app.example/callback',client:{id:'c',origin:'http://app.example'}}),issuer),'plain http only on loopback');
 assert.throws(()=>parseAccounts({accounts:[{account:{id:'not-a-uuid',handle:'x'},sessionContext:'c'}]}));
 const accounts=parseAccounts({accounts:[{account:{id:A,handle:'alex'},sessionContext:'ca'},{account:{id:B,handle:'sam'},sessionContext:'cb'}]});
 assert.deepEqual(eligibleAccounts(accounts,{loginHint:'sam@provider.example'},issuer).map(a=>[a.handle,a.hinted]),[['sam',true],['alex',false]]);
 assert.deepEqual(eligibleAccounts(accounts,{subjectConstraint:`${issuer}/entities/${A}`},issuer).map(a=>a.handle),['alex'],'a constrained entry lists only its subject');
 assert.deepEqual(durationOf(300),{count:5,unit:'minutes'});assert.deepEqual(durationOf(30),{count:30,unit:'seconds'});
});

test('catalogue: English and Spanish keys match and the entry strings localize',()=>{
 assert.deepEqual(Object.keys(authorizeCatalogue.en['']).sort(),Object.keys(authorizeCatalogue.es['']).sort());
 const {t}=authorizeLocalization('es-MX');assert.equal(t('Continue as {account}',{account:'ray@x'}),'Continuar como ray@x');assert.equal(t('Allow selected access'),'Permitir el acceso seleccionado');
 assert.equal(t.plural('{#} minutes','{#} minute',1),'1 minuto');assert.equal(authorizeLocalization('en').t.plural('{#} minutes','{#} minute',5),'5 minutes');
});

test('embed origin discovery and exact bridge message schemas',()=>{
 const manifest={profiles:{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:embed}}};
 assert.equal(embedOriginFor({entry:{},manifest,issuer}),embed);assert.equal(embedOriginFor({entry:{embed:{origin:embed+'/path'}},manifest,issuer}),null);
 assert.equal(embedOriginFor({entry:{},manifest:{profiles:{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:issuer}}},issuer}),null,'the issuer is never an embed origin');
 assert.equal(embedOriginFor({entry:{},manifest:null,issuer}),null);
 assert.equal(validProof({v:1,type:'bindle-embed-proof',proof:'a.b.c'}),true);assert.equal(validProof({v:1,type:'bindle-embed-proof',proof:'a.b.c',extra:1}),false);assert.equal(validProof({v:1,type:'bindle-embed-proof',proof:'<script>'}),false);
 assert.equal(validAck({v:1,type:'bindle-embed-ack',entry:entryId},entryId),true);assert.equal(validAck({v:1,type:'bindle-embed-ack',entry:'x'},entryId),false);
});

function fakeWindow(opener){const target=new EventTarget();return {opener,addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target),emit:(data,source,origin)=>{const event=new Event('message');Object.assign(event,{data,source,origin});target.dispatchEvent(event);}};}
test('handshake answers only the opener at the embed origin and times out into plain mode',async()=>{
 const posts=[],opener={postMessage:(data,origin)=>posts.push({data,origin})},win=fakeWindow(opener),calls=[];
 const api={post:async(path,body)=>{calls.push({path,body});return path.endsWith('embed-challenge')?{challenge:'C'.repeat(22)}:{pageSecret:'S'.repeat(43)};}};
 const running=runHandshake({win,api,entryId,embedOrigin:embed,timeoutMs:200});await sleep(10);
 assert.deepEqual(posts,[{data:{v:1,type:'bindle-embed-hello',entry:entryId,challenge:'C'.repeat(22)},origin:embed}],'hello goes to the opener with the exact embed origin');
 win.emit({v:1,type:'bindle-embed-proof',proof:'x.y.z'},{},embed);win.emit({v:1,type:'bindle-embed-proof',proof:'x.y.z'},opener,app);win.emit({v:1,type:'bindle-embed-proof',proof:'x.y.z',more:1},opener,embed);
 win.emit({v:1,type:'bindle-embed-proof',proof:'good.proof.sig'},opener,embed);
 assert.equal(await running,'S'.repeat(43));assert.deepEqual(calls.map(c=>c.path),[`/oauth/entries/${entryId}/embed-challenge`,`/oauth/entries/${entryId}/embed-verify`]);assert.equal(calls[1].body.proof,'good.proof.sig');
 assert.equal(await runHandshake({win:fakeWindow(null),api,entryId,embedOrigin:embed}),null,'no opener: plain');
 const silent=fakeWindow({postMessage(){}});assert.equal(await runHandshake({win:silent,api,entryId,embedOrigin:embed,timeoutMs:50}),null,'no proof in time: plain');
 const refused={post:async path=>{if(path.endsWith('embed-verify'))throw Object.assign(new Error('x'),{code:'embed_attestation_failed'});return {challenge:'C'.repeat(22)};}},w2=fakeWindow(opener);const p2=runHandshake({win:w2,api:refused,entryId,embedOrigin:embed,timeoutMs:200});await sleep(10);w2.emit({v:1,type:'bindle-embed-proof',proof:'a.b.c'},opener,embed);assert.equal(await p2,null);
 const w3=fakeWindow(opener);posts.length=0;const delivered=deliverToOpener({win:w3,embedOrigin:embed,entryId,result:{code:'c',state:'s',iss:issuer,claim:'k'.repeat(43)},timeoutMs:200});await sleep(5);
 assert.deepEqual(posts[0],{data:{v:1,type:'bindle-embed-done',entry:entryId,code:'c',state:'s',iss:issuer,claim:'k'.repeat(43)},origin:embed});w3.emit({v:1,type:'bindle-embed-ack',entry:entryId},{},embed);w3.emit({v:1,type:'bindle-embed-ack',entry:entryId},opener,embed);assert.equal(await delivered,true);
 assert.equal(await deliverToOpener({win:fakeWindow({postMessage(){}}),embedOrigin:embed,entryId,result:{},timeoutMs:30}),false);
});

test('delay-to-arm: early, untrusted and post-interruption activations are ignored',async()=>{
 const target=new EventTarget(),doc=Object.assign(new EventTarget(),{visibilityState:'visible',focused:true,hasFocus(){return this.focused;}}),win={innerWidth:800,addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target)};
 const rejected=[],arming=createArming({win,doc,delay:40,onReject:()=>rejected.push(1)}),hits=[],act=arming.guard(()=>hits.push(1));
 const down=()=>{const e=new Event('pointerdown');Object.defineProperty(e,'isTrusted',{value:true});doc.dispatchEvent(e);};
 down();act({isTrusted:true});assert.equal(hits.length,0,'not armed yet');assert.equal(rejected.length,1,'an early trusted press is reported');
 await sleep(60);assert.equal(arming.armed,true);act({isTrusted:true});assert.equal(hits.length,0,'a press that started before arming does not count');
 down();act({isTrusted:false});assert.equal(hits.length,0,'untrusted');act({isTrusted:true});assert.equal(hits.length,1);act({isTrusted:true});assert.equal(hits.length,1,'one press, one activation');down();
 doc.focused=false;target.dispatchEvent(new Event('blur'));assert.equal(arming.armed,false);await sleep(60);assert.equal(arming.armed,false,'stays disarmed without focus');
 doc.focused=true;target.dispatchEvent(new Event('focus'));await sleep(60);assert.equal(arming.armed,true);arming.reset();assert.equal(arming.armed,false,'a new surface disarms');act({isTrusted:true});assert.equal(hits.length,1);arming.dispose();
});

// ---- Page flows -------------------------------------------------------------------------------------------
function server(routes){const calls=[];const fetch=async(path,options={})=>{const call={path,method:options.method??'GET',headers:options.headers??{},credentials:options.credentials,body:options.body?JSON.parse(options.body):undefined};calls.push(call);for(const [match,reply] of routes){if(typeof match==='string'?match===`${call.method} ${path}`:match.test(`${call.method} ${path}`)){const value=await reply(call);return value instanceof Response?value:json(value);}}return json({error:'not_found'},404);};return {fetch,calls};}
function harness({routes,opener=null,framed=false,location=`?entry=${entryId}`}){
 const root=document.createElement('div');document.body.replaceChildren(root);
 const nav=[],posts=[],winTarget=new EventTarget();
 const win=Object.assign(winTarget,{document,location:window.location,opener,BroadcastChannel:undefined,setInterval:()=>0,clearInterval(){},open(){nav.push({open:true});return null;}});
 window.document.hasFocus=()=>true;
 const browser={win,origin:issuer,get location(){return {pathname:'/oauth/authorize',search:location};},framed:()=>framed,sandboxed:()=>false,now:()=>Date.now(),replace:url=>nav.push({replace:url}),assign:url=>nav.push({assign:url}),close:()=>nav.push({close:true})};
 const {fetch,calls}=server(routes);const page=startEntryPage({root,preferredLocale:'en',win,fetch,browser});
 return {root,page,calls,nav,posts,win};
}
const until=async(check,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=check();if(value)return value;await sleep(10);}throw new Error('Timed out waiting for state.');};
// A trusted activation as the browser would deliver it (happy-dom marks script clicks untrusted, which the guard refuses).
function press(button){const down=new window.Event('pointerdown',{bubbles:true});Object.defineProperty(down,'isTrusted',{value:true});button.dispatchEvent(down);const event=new window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1});Object.defineProperty(event,'isTrusted',{value:true});button.dispatchEvent(event);}
const accountRoutes=(accounts=[[A,'alex','ca'],[B,'sam','cb']])=>[
 ['GET /api/auth/accounts',()=>({accounts:accounts.map(([id,handle,sessionContext])=>({account:{id,handle},sessionContext,expiresAt:Date.now()+3600000}))})],
 ['GET /api/session',call=>{const row=accounts.find(([id])=>id===call.headers['X-Bindle-Account']);return row?{authenticated:true,account:{id:row[0],handle:row[1]},csrfToken:'csrf-'+row[1],sessionContext:row[2]}:{authenticated:false};}]];

test('app-initiated popup: chooser lists browser accounts; one armed click selects, decides and returns the code to the registered callback',async()=>{
 const requestId=`${B}.${'R'.repeat(43)}`;
 const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view()],...accountRoutes(),
  [`POST /api/oauth/entries/${entryId}/select`,()=>({requestId})],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>({requestId,authenticated:true,client:{id:app+'/client',name:'Example app',origin:app,redirectUris:[app+'/callback']},requests:[]})],
  [`POST /api/oauth/entries/${entryId}/decision`,()=>({redirectUri:`${app}/callback?code=CODE&state=S&iss=${encodeURIComponent(issuer)}`})]]});
 await until(()=>h.root.querySelectorAll('.account-row').length===2);
 assert.match(h.root.textContent,/Sign in to .*Example app/);assert.match(h.root.textContent,/alex@provider\.example/);assert.match(h.root.textContent,/will receive your account’s ID/);assert.match(h.root.textContent,/App website: bindle|App website: app\.example/);
 assert.equal(h.root.querySelector('h1').getAttribute('tabindex'),'-1');assert.equal(document.activeElement?.tagName==='BUTTON',false,'no approval control takes default focus');
 const sam=[...h.root.querySelectorAll('[data-entry-approve]')].find(b=>b.textContent.includes('sam@'));assert.equal(sam.getAttribute('aria-disabled'),'true','unarmed at first');
 press(sam);await sleep(20);assert.equal(h.calls.some(c=>c.path.endsWith('/select')),false,'an early click does nothing');assert.match(h.root.querySelector('[role="status"][aria-live]').textContent,/Ready in a moment/,'an early trusted tap is explained, not silently dropped');
 await until(()=>!h.root.querySelector('[data-entry-approve]')?.hasAttribute('aria-disabled'),1500);sam.dispatchEvent(new window.MouseEvent('click',{bubbles:true,detail:1}));await sleep(20);assert.equal(h.calls.some(c=>c.path.endsWith('/select')),false,'untrusted (script-dispatched) clicks are ignored');
 press([...h.root.querySelectorAll('[data-entry-approve]')].find(b=>b.textContent.includes('sam@')));
 await until(()=>h.nav.some(n=>n.assign));
 const select=h.calls.find(c=>c.path.endsWith('/select'));assert.deepEqual(select.body,{nonce});assert.equal(select.headers['X-Bindle-Account'],B);assert.equal(select.headers['X-Bindle-Session-Context'],'cb');assert.equal(select.headers['X-CSRF-Token'],'csrf-sam');assert.equal(select.headers['X-Bindle-Entry-Token'],pageToken);
 const decision=h.calls.find(c=>c.path.endsWith('/decision'));assert.deepEqual(decision.body,{nonce,approved:[]});assert.equal(decision.headers['X-Bindle-Entry-Token'],pageToken);
 assert.deepEqual(h.nav,[{assign:`${app}/callback?code=CODE&state=S&iss=${encodeURIComponent(issuer)}`}]);
 // Before the click the only requests were the entry view and this browser's own same-origin inventory.
 const before=h.calls.slice(0,h.calls.indexOf(h.calls.find(c=>c.path==='/api/session')));assert.deepEqual(before.map(c=>`${c.method} ${c.path}`),[`GET /api/oauth/entries/${entryId}`,'GET /api/auth/accounts']);
 h.page.dispose();
});

test('requested fragments go through the shared consent review; a decision that names another callback never navigates',async()=>{
 const requestId=`${A}.${'R'.repeat(43)}`,fragment='https://schema.example/settings/v1';
 const consent={requestId,authenticated:true,client:{id:app+'/client',name:'Example app',origin:app,redirectUris:[app+'/callback']},requests:[{fragment,required:true,purpose:'Theme',fields:['theme'],schema:{title:'Settings',description:'Shared settings',publisher:'https://schema.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']}}},values:{theme:'dark'},revision:'r1',resources:[],affectedApps:[]}]};
 let redirect=`https://evil.example/callback?code=X`;
 const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}]})],...accountRoutes([[A,'alex','ca']]),[`POST /api/oauth/entries/${entryId}/select`,()=>({requestId})],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>consent],[`POST /api/oauth/entries/${entryId}/decision`,()=>({redirectUri:redirect})]]});
 await until(()=>h.root.querySelector('.account-row'));assert.match(h.root.textContent,/review the access/);
 await until(()=>!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));
 await until(()=>h.root.querySelector('main').dataset.phase==='consent');assert.match(h.root.textContent,/Review what .*Example app.* can access/);assert.match(h.root.textContent,/Settings/);assert.match(h.root.textContent,/alex@provider\.example/);
 const allow=()=>h.root.querySelector('[data-consent-approve="true"]');assert.equal(allow().getAttribute('aria-disabled'),'true','the consent surface re-arms after the account click');
 await until(()=>!allow().hasAttribute('aria-disabled'),1500);press(allow());
 await until(()=>h.root.querySelector('[role="alert"]'));assert.match(h.root.textContent,/callback origin does not match/);assert.deepEqual(h.nav,[],'no navigation to an unregistered callback');
 const decision=h.calls.find(c=>c.path.endsWith('/decision'));assert.deepEqual(decision.body.approved,[{fragment,revision:'r1',fields:['theme'],resources:{},methods:{}}]);
 h.page.dispose();
});

test('frame-initiated popup: nothing renders or loads before the opener proves the key; approval goes only to the embed origin',async()=>{
 const posts=[],opener={postMessage:(data,origin)=>{posts.push({data,origin});queueMicrotask(()=>{const reply=data.type==='bindle-embed-hello'?{v:1,type:'bindle-embed-proof',proof:'p.r.f'}:data.type==='bindle-embed-done'?{v:1,type:'bindle-embed-ack',entry:entryId}:null;if(reply){const event=new Event('message');Object.assign(event,{data:reply,source:opener,origin:embed});h.win.dispatchEvent(event);}});}};
 const requestId=`${A}.${'R'.repeat(43)}`,manifest={profiles:{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:embed}}};
 let release;const gate=new Promise(r=>release=r);
 const h=harness({opener,routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({delivery:'embed-popup',embed:{attested:false,plain:false}})],['GET /.well-known/bindle/manifest.json',()=>manifest],
  [`POST /oauth/entries/${entryId}/embed-challenge`,async()=>{await gate;return {challenge:'C'.repeat(22)};}],[`POST /oauth/entries/${entryId}/embed-verify`,()=>({pageSecret:'S'.repeat(43)})],...accountRoutes([[A,'alex','ca']]),
  [`POST /api/oauth/entries/${entryId}/select`,()=>({requestId})],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>({requestId,authenticated:true,client:{id:app+'/client',name:'Example app',origin:app},requests:[]})],
  [`POST /api/oauth/entries/${entryId}/decision`,()=>({code:'CODE',state:'S',iss:issuer,claim:'K'.repeat(43)})]]});
 await sleep(30);assert.equal(h.root.querySelector('main').dataset.phase,'handshake');assert.doesNotMatch(h.root.textContent,/alex|Example app/,'no account state or app identity before attestation');
 assert.equal(h.calls.some(c=>c.path==='/api/auth/accounts'||c.path==='/api/session'),false,'no account request before attestation');
 release();await until(()=>h.root.querySelector('.account-row'));
 assert.deepEqual(posts[0],{data:{v:1,type:'bindle-embed-hello',entry:entryId,challenge:'C'.repeat(22)},origin:embed});
 assert.deepEqual(h.calls.filter(c=>c.path.includes('/embed-')).map(c=>c.headers['X-Bindle-Entry-Token']),[pageToken,pageToken],'the handshake carries the page token');
 await until(()=>!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));
 await until(()=>h.nav.some(n=>n.close));
 assert.deepEqual(h.calls.find(c=>c.path.endsWith('/select')).body,{nonce,pageSecret:'S'.repeat(43)});assert.deepEqual(h.calls.find(c=>c.path.endsWith('/decision')).body,{nonce,approved:[],pageSecret:'S'.repeat(43)});
 assert.deepEqual(posts.map(p=>p.origin),[embed,embed],'every message targets the exact embed origin');assert.deepEqual(posts[1].data,{v:1,type:'bindle-embed-done',entry:entryId,code:'CODE',state:'S',iss:issuer,claim:'K'.repeat(43)});
 assert.deepEqual(h.nav,[{close:true}],'acknowledged: the popup closes itself and never redirects');
 h.page.dispose();
});

test('frame-initiated entry without a provable opener is replaced by the plain page before anything renders',async()=>{
 const h=harness({opener:null,routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({delivery:'embed-popup',embed:{attested:false,plain:false}})],['GET /.well-known/bindle/manifest.json',()=>({profiles:{'https://3sln.me/artefacts/profiles/components/v1':{embed_origin:embed}}})],...accountRoutes()]});
 await until(()=>h.nav.length);assert.deepEqual(h.nav,[{replace:`/oauth/authorize?entry=${entryId}&mode=plain`}]);assert.equal(h.calls.some(c=>/accounts|session|challenge/.test(c.path)),false);assert.doesNotMatch(h.root.textContent,/alex/);h.page.dispose();
 // The plain page (COOP same-origin) runs as an ordinary flow and declares plain mode on every owner step.
 const requestId=`${A}.${'R'.repeat(43)}`;
 const p=harness({location:`?entry=${entryId}&mode=plain`,routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({delivery:'embed-popup',embed:{attested:false,plain:false}})],[`POST /api/oauth/entries/${entryId}/plain`,()=>({plain:true})],...accountRoutes([[A,'alex','ca']]),[`POST /api/oauth/entries/${entryId}/select`,()=>({requestId})],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>({requestId,authenticated:true,client:{id:app+'/client',origin:app},requests:[]})],[`POST /api/oauth/entries/${entryId}/decision`,()=>({redirectUri:`${app}/callback?code=C&state=S&iss=${encodeURIComponent(issuer)}`})]]});
 await until(()=>p.root.querySelector('.account-row'));await until(()=>!p.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(p.root.querySelector('[data-entry-approve]'));await until(()=>p.nav.length);
 const declared=p.calls.find(c=>c.path.endsWith('/plain'));assert.equal(declared.credentials,'omit');assert.equal(declared.headers['X-Bindle-Entry-Token'],pageToken);assert.ok(p.calls.indexOf(declared)<p.calls.findIndex(c=>c.path==='/api/auth/accounts'),'declared before any account request');
 assert.deepEqual(p.calls.find(c=>c.path.endsWith('/select')).body,{nonce,plain:true});assert.equal(p.calls.some(c=>c.path.includes('embed-')),false);assert.match(p.nav[0].assign,/code=C/);p.page.dispose();
});

test('reauthenticate: a stale session asks for a fresh sign-in and continues only as the constrained account',async()=>{
 let fresh=false;const requestId=`${A}.${'R'.repeat(43)}`;
 const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({intent:'reauthenticate',subjectConstraint:`${issuer}/entities/${A}`,maxAge:300})],...accountRoutes(),
  [`POST /api/oauth/entries/${entryId}/select`,()=>fresh?{requestId}:json({error:'reauthentication_required',message:'Sign in again to confirm this account.'},401)],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>({requestId,authenticated:true,client:{id:app+'/client',origin:app},requests:[]})],[`POST /api/oauth/entries/${entryId}/decision`,()=>({redirectUri:`${app}/callback?code=C&state=S&iss=${encodeURIComponent(issuer)}`})]]});
 await until(()=>h.root.querySelector('.account-row'));assert.equal(h.root.querySelectorAll('.account-row').length,1,'only the requested account is offered');assert.doesNotMatch(h.root.textContent,/sam@/);assert.match(h.root.textContent,/less than 5 minutes ago/);
 await until(()=>!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));
 await until(()=>h.root.querySelector('main').dataset.phase==='reauth');assert.match(h.root.textContent,/sign in again as .*alex@provider\.example/);
 const signIn=[...h.root.querySelectorAll('a')].find(a=>a.textContent==='Sign in again');assert.equal(signIn.getAttribute('href'),'/console?signin');assert.equal(signIn.getAttribute('target'),'_blank');assert.equal(signIn.getAttribute('rel'),'noopener noreferrer');signIn.addEventListener('click',e=>e.preventDefault(),{once:true});signIn.click();await sleep(20);assert.deepEqual(h.nav,[]);assert.match(h.root.textContent,/Finish signing in on the new tab/);assert.match(h.root.textContent,/choose Add account and sign in again as/);
 fresh=true;await until(()=>!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));
 await until(()=>h.nav.some(n=>n.assign));assert.match(h.nav.at(-1).assign,/code=C/);h.page.dispose();
});

test('end-session: explicit confirmation names the account; both answers return only completed or canceled',async()=>{
 for(const [label,confirmed,result] of [['Sign out',true,'completed'],['Stay signed in',false,'canceled']]){
  const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({intent:'end-session',subjectConstraint:`${issuer}/entities/${A}`,presentation:'redirect',delivery:'redirect'})],...accountRoutes(),
   [`POST /api/oauth/entries/${entryId}/end-session`,call=>({redirectUri:`${app}/callback?result=${call.body.confirmed?'completed':'canceled'}&state=S&iss=${encodeURIComponent(issuer)}`})]]});
  await until(()=>h.root.querySelector('main')?.dataset.phase==='end-session'&&h.root.textContent.includes('alex@'));
  assert.match(h.root.querySelector('h1').textContent,/Sign out .*alex@provider\.example.*\?/);assert.match(h.root.textContent,/asked to sign you out of provider\.example/);assert.match(h.root.textContent,/Other accounts on this browser/);assert.doesNotMatch(h.root.textContent,/sam@/);
  const button=[...h.root.querySelectorAll('button')].find(b=>b.textContent===label);
  if(confirmed){await until(()=>!button.hasAttribute('aria-disabled')||!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));}else button.click();
  await until(()=>h.nav.length);const call=h.calls.find(c=>c.path.endsWith('/end-session'));assert.deepEqual(call.body,{nonce,confirmed});
  assert.equal(call.headers['X-Bindle-Entry-Token'],pageToken);if(confirmed){assert.equal(call.headers['X-Bindle-Account'],A);assert.equal(call.headers['X-CSRF-Token'],'csrf-alex');}else{assert.equal(call.headers['X-CSRF-Token'],undefined);assert.equal(call.credentials,'omit');}
  assert.equal(new URL(h.nav[0].assign).searchParams.get('result'),result);h.page.dispose();
 }
});

test('already approved: the account click resubmits the granted access with no consent screen; a refusal falls back to review',async()=>{
 const fragment='https://schema.example/settings/v1',requestId=`${A}.${'R'.repeat(43)}`,approved=[{fragment,fields:['theme'],revision:'r1',resources:{},methods:{}}];
 const consent={requestId,authenticated:true,client:{id:app+'/client',name:'Example app',origin:app,redirectUris:[app+'/callback']},requests:[{fragment,required:true,purpose:'Theme',fields:['theme'],schema:{title:'Settings',description:'Shared settings',publisher:'https://schema.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']}}},values:{theme:'dark'},revision:'r1',resources:[],affectedApps:[]}]};
 for(const refuse of [false,true]){
  const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view({requests:[{fragment,required:true,purpose:'Theme',fields:['theme']}]})],...accountRoutes([[A,'alex','ca']]),[`POST /api/oauth/entries/${entryId}/select`,()=>({requestId,approved})],[`GET /api/oauth/requests/${encodeURIComponent(requestId)}`,()=>consent],
   [`POST /api/oauth/entries/${entryId}/decision`,()=>refuse?json({error:'stale_consent',message:'x'},409):{redirectUri:`${app}/callback?code=C&state=S&iss=${encodeURIComponent(issuer)}`}]]});
  await until(()=>h.root.querySelector('.account-row'));await until(()=>!h.root.querySelector('[data-entry-approve]').hasAttribute('aria-disabled'),1500);press(h.root.querySelector('[data-entry-approve]'));
  if(!refuse){await until(()=>h.nav.length);assert.match(h.nav[0].assign,/code=C/);assert.deepEqual(h.calls.find(c=>c.path.endsWith('/decision')).body,{nonce,approved});assert.equal(h.calls.filter(c=>c.path.includes('/requests/')).length,1,'inspected once (connection review), no consent screen');}
  else{await until(()=>h.root.querySelector('main').dataset.phase==='consent');assert.match(h.root.textContent,/Review what .*Example app.* can access/);assert.deepEqual(h.nav,[]);}
  h.page.dispose();
 }
});

test('anonymous cancel, framed documents and expired entries reveal nothing',async()=>{
 const h=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>view()],...accountRoutes(),[`POST /api/oauth/entries/${entryId}/decision`,()=>({redirectUri:`${app}/callback?error=access_denied&state=S&iss=${encodeURIComponent(issuer)}`})]]});
 await until(()=>h.root.querySelector('.account-row'));[...h.root.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click();await until(()=>h.nav.length);
 const cancel=h.calls.find(c=>c.path.endsWith('/decision'));assert.deepEqual(cancel.body,{nonce,denied:true});assert.equal(cancel.headers['X-Bindle-Account'],undefined,'no member is named before a choice');assert.equal(cancel.headers['X-CSRF-Token'],undefined,'the public nonce is never a CSRF token');assert.equal(cancel.headers['X-Bindle-Entry-Token'],pageToken);assert.equal(cancel.credentials,'omit','an anonymous cancel carries no cookies');
 assert.equal(new URL(h.nav[0].assign).searchParams.get('error'),'access_denied');h.page.dispose();
 const framed=harness({framed:true,routes:[]});await until(()=>framed.root.querySelector('main')?.dataset.phase==='framed');assert.deepEqual(framed.calls,[],'a framed document makes no request');assert.equal(framed.root.querySelectorAll('button').length,0);framed.page.dispose();
 const gone=harness({routes:[[`GET /api/oauth/entries/${entryId}`,()=>json({error:'invalid_request',message:'This sign-in expired. Start again from the application.'},400)]]});await until(()=>gone.root.querySelector('main')?.dataset.phase==='expired');assert.match(gone.root.textContent,/This sign-in has expired/);assert.equal(gone.calls.length,1);gone.page.dispose();
});

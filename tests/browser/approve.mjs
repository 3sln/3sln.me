import test from 'node:test';import assert from 'node:assert/strict';import {Window} from 'happy-dom';
import {createServer} from 'node:http';import {resolve} from 'node:path';import {build} from 'esbuild';import {chromium} from 'playwright';
const window=new Window({url:'https://provider.example/approve'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {ApproveAction,ApproveView,createApproveState,createApproveAPI,normalizeApprovalCode,approvalLocator,approvalDurations,validApprovalReview,startApprovePage}=await import('../../apps/web/src/bl/approve.mjs');
const {ConfirmOwner,CancelOwnerConfirmation}=await import('../../apps/web/src/bl/step-up.mjs');
const {approveLocalization,approveCatalogue}=await import('../../packages/i18n/approve-catalogue.mjs');
const {approveView}=await import('../../apps/web/src/ui/approve.mjs');
const {consentKit}=await import('../../apps/web/src/ui/authorize-entry-consent.mjs');
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const A='550e8400-e29b-41d4-a716-446655440001',B='550e8400-e29b-41d4-a716-446655440002',R='550e8400-e29b-41d4-a716-446655440003',NOW=1792512000000,HOUR=3600000;
const member=(id=A,context='ca')=>({account:{id,handle:id===A?'alice':'sam'},sessionContext:context,csrfToken:'csrf-'+context});
const fragment=(overrides={})=>({fragment:'https://schema.example/profile/v1',required:false,sensitive:true,fields:['theme'],revision:'r1',values:{theme:'dark'},methods:{},resources:[],affectedApps:[],consumerDigest:'d1',purpose:'A requested theme',schema:{title:'Preferences',description:'Theme selection',publisher:'schema.example',fields:{theme:{type:'string',title:'Theme',maxLength:128}}},...overrides});
const review=(kind='session',overrides={})=>({request:{id:R,kind,createdAt:NOW-60000,expiresAt:NOW+600000,deviceKind:'tv',client:{origin:'https://acme.example',reviewed:true,name:'EVIL CLAIMED NAME'},...overrides},session:{expiresAt:NOW+24*HOUR,authAt:NOW,sessionTtlMs:24*HOUR},consent:{requests:[]}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<100;i++){if(check())return;await sleep(5);}assert.fail('condition did not become true');}
function harness({accounts=[member()],value=review(),hash='',draft=null,failResolve=null}={}){
 const state=createApproveState(),secrets={},calls=[],browser={now:()=>NOW,location:()=>({hash}),clearFragment(){this.cleared=true;},readDraft:()=>draft,saveDraft(v){this.saved=v;},clearDraft(){this.saved=null;},navigate(path){this.path=path;},framed:()=>false,approvalArmed:()=>true,signInProof:()=>({turnstileToken:'mock-proof'}),authenticatePasskey:async()=>({id:'verified-passkey'}),focus(){}};
 let inventory=accounts,current=null,stepUp=false;
 const api={setContext(v){current=v;},async get(path){calls.push({path,member:current});if(path==='/api/auth/accounts')return {accounts:inventory};if(path==='/api/session')return inventory.find(a=>a.account.id===current?.account?.id)??{};throw Error(path);},async request(path,input){calls.push({path,input,member:current});
  if(path==='/api/auth/login/password'||path==='/api/auth/login/passkey/finish'){const m=member(input.handle==='sam'?B:A,'fresh');inventory=[...inventory.filter(a=>a.account.id!==m.account.id),m];return m;}
  if(path==='/api/auth/login/passkey/begin')return {challengeToken:'challenge',authenticationOptions:{}};
  if(path==='/api/auth/linked/resolve'){if(failResolve)throw Object.assign(Error('untrusted server text'),{code:failResolve});return structuredClone(value);}
  if(path==='/api/auth/step-up/begin')return {passkey:true,password:true,authenticationOptions:{}};
  if(path==='/api/auth/step-up'){stepUp=true;return {};}
  if(path==='/api/auth/linked/approve')return {expiresAt:input.choice==='ongoing'?null:NOW+({'1h':HOUR,'8h':8*HOUR}[input.choice]??input.choice)};if(path==='/api/auth/linked/deny')return {};
  if(path==='/api/auth/linked/configure')return value;throw Error(path);
 }};
 const i18n=approveLocalization('en'),root=document.createElement('div'),kit=consentKit({model:state.model,t:i18n.t,root,rerender(){},onConfigure(){}});
 const engine=new Engine({providers:Object.fromEntries(Object.entries({state,secrets,api,browser,i18n,consent:kit}).map(([k,v])=>[k,Provider.fromSingleton(v)]))});
 return {engine,state,secrets,calls,browser,api,kit,root,get stepUp(){return stepUp;},setAccounts:v=>{inventory=v;},run:(kind,detail)=>engine.dispatch(new ApproveAction(kind,detail)).next('complete'),dispose:()=>engine.dispose()};
}
async function choose(h,id=A,context='ca'){await h.run('boot');await h.run('code',{code:'bcdf ghjk'});await h.run('choose',{id,sessionContext:context});}

test('code, locator, draft and review validation discard URL codes and unreviewed client claims',()=>{
 assert.equal(normalizeApprovalCode(' bcdf-ghjk '),'BCDFGHJK');for(const code of ['ABCDGHJK','BCDFGHJ1','BCDFGHJ','BCDF\tGHJK',null])assert.equal(normalizeApprovalCode(code),null);
 assert.equal(approvalLocator('#request='+R+'&code=URLSECRET'),R);assert.equal(approvalLocator('#code=BCDFGHJK'),null);
 const v=validApprovalReview(review('app'),NOW);assert.equal(v.request.host,'acme.example');assert.equal(JSON.stringify(v).includes('EVIL'),false);
 for(const origin of ['https://evil:pw@acme.example','http://acme.example','https://acme.example/path'])assert.throws(()=>validApprovalReview(review('app',{client:{origin,reviewed:true}}),NOW));
 assert.throws(()=>validApprovalReview(review('app',{client:{origin:'https://acme.example',reviewed:false}}),NOW));assert.throws(()=>validApprovalReview(review('session',{expiresAt:NOW}),NOW));
 const nonfresh=review();nonfresh.session.authAt=null;assert.equal(validApprovalReview(nonfresh,NOW).session.authAt,0);
 assert.equal(approvalDurations(v.request,v.session,NOW)[0].value,'ongoing');assert.equal(approvalDurations({kind:'session'},{expiresAt:NOW+5000},NOW).length,1);
 assert.equal(approvalDurations({kind:'session'},{expiresAt:NOW+24*HOUR},NOW).at(-1).value,24*HOUR);
});

test('engine harness: signed out → password sign-in → approve stays in one flow and sends typed code',async t=>{
 const h=harness({accounts:[],hash:'#request='+R+'&code=URLSECRET'});t.after(h.dispose);let projection;const subscription=h.engine.query(new ApproveView()).subscribe({next:v=>projection=v});t.after(()=>subscription.unsubscribe());
 await h.run('boot');assert.equal(h.browser.cleared,true);assert.equal(h.state.model.draft,'');assert.equal(h.calls.length,1);
 await h.run('code',{code:'bcdf-ghjk'});assert.equal(h.state.model.phase,'signin');assert.equal(h.calls.some(c=>c.path.includes('resolve')),false);
 await h.run('signin',{method:'password',values:{handle:'alice',password:'never-project-me'}});assert.equal(h.state.model.phase,'review');assert.equal(h.state.model.choice,24*HOUR);assert.equal(h.browser.path,undefined);
 await h.run('approve');assert.equal(h.state.model.phase,'approved');const call=h.calls.find(c=>c.path.endsWith('/approve'));assert.equal(call.input.code,'BCDFGHJK');assert.equal(call.input.owner,A);assert.equal(call.input.sessionContext,'fresh');assert.equal(h.secrets.code,null);assert.equal(JSON.stringify(projection).includes('never-project-me'),false);
});

test('engine harness: explicit multi-account selection, session binding and lost membership',async t=>{
 const h=harness({accounts:[member(),member(B,'cb')]});t.after(h.dispose);await choose(h);assert.equal(h.state.model.selected.id,A);assert.equal(h.state.model.phase,'review');
 await h.run('another');assert.equal(h.state.model.phase,'choose');assert.equal(h.state.model.busy,false);await h.run('choose',{id:B,sessionContext:'cb'});assert.equal(h.state.model.selected.id,B);
 h.setAccounts([member()]);await h.run('accounts');assert.equal(h.state.model.request,null);assert.equal(h.state.model.session,null);assert.equal(h.state.model.phase,'choose');await h.run('approve');assert.equal(h.calls.filter(c=>c.path.endsWith('/approve')).length,0);
});

test('engine harness: app requires new credential sign-in, ongoing default and optional sensitive consent',async t=>{
 const value=review('app');value.consent.requests=[fragment()];const h=harness({value});t.after(h.dispose);await choose(h);assert.equal(h.state.model.phase,'signin');assert.equal(h.state.model.signInReason,'app');
 await h.run('signin',{method:'passkey',values:{handle:'alice'}});assert.equal(h.state.model.phase,'review');assert.equal(h.state.model.choice,'ongoing');
 await h.run('approve');assert.equal(h.calls.filter(c=>c.path.endsWith('/approve')).length,0,'sensitive access needs its separate tick');
 await h.run('sensitive',{fragment:value.consent.requests[0].fragment,checked:true});await h.run('duration',{value:'8h'});await h.run('approve');assert.equal(h.state.model.phase,'approved');const input=h.calls.find(c=>c.path.endsWith('/approve')).input;assert.equal(input.choice,'8h');assert.deepEqual(input.consent[0].fields,['theme']);assert.equal(input.sensitive.length,1);
 const h2=harness({value});t.after(h2.dispose);await choose(h2);await h2.run('signin',{method:'password',values:{handle:'alice',password:'x'}});h2.kit.selection(value.consent.requests[0]).declined=true;await h2.run('approve');assert.deepEqual(h2.calls.find(c=>c.path.endsWith('/approve')).input.consent,[]);
});

test('engine harness: old credential opens existing inline step-up, passkey preferred, request resumes once',async t=>{
 const value=review();value.session.authAt=0;const h=harness({value});t.after(h.dispose);await h.run('boot');await h.run('code',{code:'BCDFGHJK'});const pending=h.run('choose',{id:A,sessionContext:'ca'});await until(()=>h.state.model.stepUp);
 assert.equal(h.state.model.phase,'credential');assert.equal(h.state.model.stepUp.password,false);assert.equal(h.state.model.stepUp.passkey,true);
 await h.engine.dispatch(new ConfirmOwner({id:h.state.model.stepUp.id,method:'passkey'})).next('complete');await pending;assert.equal(h.state.model.phase,'review');assert.equal(h.stepUp,true);assert.equal(h.state.model.stepUp,null);await h.run('approve');assert.equal(h.calls.filter(c=>c.path.endsWith('/approve')).length,1);
});

test('engine harness: owner change during step-up cancels the suspended request',async t=>{
 const value=review();value.session.authAt=0;const h=harness({value});t.after(h.dispose);await h.run('boot');await h.run('code',{code:'BCDFGHJK'});const pending=h.run('choose',{id:A,sessionContext:'ca'});await until(()=>h.state.model.stepUp);
 h.setAccounts([member(B,'cb')]);await h.run('accounts');await pending;assert.equal(h.state.model.phase,'choose');assert.equal(h.state.model.request,null);assert.equal(h.state.model.busy,false);assert.equal(h.calls.some(c=>c.path.endsWith('/approve')),false);
});

test('engine harness: cancelling step-up permits retry; denial has no approval side effect',async t=>{
 const value=review();value.session.authAt=0;const h=harness({value});t.after(h.dispose);await h.run('boot');await h.run('code',{code:'BCDFGHJK'});const pending=h.run('choose',{id:A,sessionContext:'ca'});await until(()=>h.state.model.stepUp);await h.engine.dispatch(new CancelOwnerConfirmation({id:h.state.model.stepUp.id})).next('complete');await pending;
 assert.equal(h.state.model.phase,'credential');assert.equal(h.state.model.busy,false);const retry=h.run('retry-credential');await until(()=>h.state.model.stepUp);await h.engine.dispatch(new ConfirmOwner({id:h.state.model.stepUp.id,method:'passkey'})).next('complete');await retry;await h.run('deny');assert.equal(h.state.model.phase,'denied');assert.equal(h.calls.filter(c=>c.path.endsWith('/approve')).length,0);assert.equal(h.calls.find(c=>c.path.endsWith('/deny')).input.code,'BCDFGHJK');
});

test('engine harness: request expiry cancels step-up and app freshness expires after five minutes',async t=>{
 const value=review();value.session.authAt=0;const h=harness({value});t.after(h.dispose);await h.run('boot');await h.run('code',{code:'BCDFGHJK'});const pending=h.run('choose',{id:A,sessionContext:'ca'});await until(()=>h.state.model.stepUp);h.browser.now=()=>NOW+600001;await h.run('expire');await pending;assert.equal(h.state.model.phase,'code');assert.equal(h.state.model.stepUp,null);assert.equal(h.secrets.code,null);assert.equal(h.state.model.busy,false);
 const app=harness({value:review('app')});t.after(app.dispose);await choose(app);await app.run('signin',{method:'password',values:{handle:'alice',password:'x'}});app.browser.now=()=>NOW+300001;await app.run('approve');assert.equal(app.state.model.phase,'signin');assert.equal(app.calls.some(c=>c.path.endsWith('/approve')),false);
});

test('engine harness: five locator misses drop the locator, generic errors do not reflect server text',async t=>{
 const h=harness({hash:'#r='+R,failResolve:'invalid_code'});t.after(h.dispose);await h.run('boot');for(let i=0;i<5;i++){await h.run('code',{code:'BCDFGHJK'});await h.run('choose',{id:A,sessionContext:'ca'});}assert.equal(h.state.model.locator,null);assert.doesNotMatch(h.state.model.error,/untrusted/);assert.equal(h.calls.some(c=>c.path.includes('inspect')),false);
});

test('engine harness: tab drafts survive navigations, restore once, and expire after ten minutes',async t=>{
 const h=harness({draft:{v:1,code:'BCDF-GHJK',locator:R,savedAt:NOW-1000}});t.after(h.dispose);await h.run('boot');assert.equal(h.state.model.phase,'choose');assert.equal(h.secrets.code,'BCDFGHJK');await h.run('navigate',{path:'/console?signup=1'});assert.equal(h.browser.saved.code,'BCDFGHJK');assert.equal(h.browser.path,'/console?signup=1');
 const stale=harness({draft:{v:1,code:'BCDFGHJK',savedAt:NOW-600001}});t.after(stale.dispose);await stale.run('boot');assert.equal(stale.state.model.draft,'');
});

test('transport keeps selected owner/context and CSRF on mutations; no codes enter the URL',async()=>{
 const calls=[],api=createApproveAPI({fetch:async(path,options)=>{calls.push({path,options});return new Response('{}',{headers:{'Content-Type':'application/json'}});}});api.setContext(member());await api.request('/api/auth/linked/resolve',{code:'BCDFGHJK'});const c=calls[0];assert.equal(c.path,'/api/auth/linked/resolve');assert.equal(c.options.headers['X-Bindle-Account'],A);assert.equal(c.options.headers['X-Bindle-Session-Context'],'ca');assert.equal(c.options.headers['X-CSRF-Token'],'csrf-ca');assert.equal(c.options.referrerPolicy,'no-referrer');assert.equal(c.options.redirect,'error');
});

test('DOM: en/es code entry is accessible, does not prefill fragments, and review names only verified hosts',async t=>{
 for(const locale of ['en','es']){const h=harness({value:review('app')});t.after(h.dispose);await h.run('boot');const render=()=>dodo.reconcile(h.root,[approveView(h.state.model,{...approveLocalization(locale),dispatch(){},kit:h.kit,armed:true})]);render();const code=h.root.querySelector('input[name=code]');assert.equal(code.autocomplete,'off');assert.equal(code.getAttribute('autocapitalize'),'characters');assert.equal(code.spellcheck,false);assert.ok(code.closest('label'));assert.ok(h.root.querySelector('[aria-live=polite]'));assert.equal(code.value,'');await h.run('code',{code:'BCDFGHJK'});await h.run('choose',{id:A,sessionContext:'ca'});await h.run('signin',{method:'password',values:{handle:'alice',password:'x'}});render();assert.match(h.root.textContent,/acme.example/);assert.doesNotMatch(h.root.textContent,/EVIL CLAIMED NAME/);assert.equal(h.root.querySelector('input[name=duration]:checked').value,'ongoing');assert.equal(h.root.querySelectorAll('input[type=radio]').length,3);}
 assert.deepEqual(Object.keys(approveCatalogue.en['']),Object.keys(approveCatalogue.es['']));
});

test('real Chromium: same-tab sign-in, code echo, consent and approval at 320/390/1440 in en/es, light/dark',async t=>{
 const entry=`import {startApprovePage} from './apps/web/src/bl/approve.mjs';globalThis.flow=startApprovePage({root:document.getElementById('app'),preferredLocale:new URL(location.href).searchParams.get('lang')||'en'});`;
 const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'approve-harness.mjs'},bundle:true,write:false,format:'esm',plugins:[{name:'stack',setup(b){b.onResolve({filter:/^\/vendor\//},a=>({path:resolve(a.path.slice(1))}));}}]});
 const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost'),path=url.pathname;res.setHeader('Cache-Control','no-store');if(path==='/page.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}if(path==='/approve'){if(url.searchParams.has('old'))res.setHeader('Set-Cookie',['old=1; SameSite=Strict; Path=/; HttpOnly','mock=1; SameSite=Strict; Path=/; HttpOnly']);res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/page.mjs"></script>');return;}
  const signed=req.headers.cookie?.includes('mock=1'),old=req.headers.cookie?.includes('old=1'),m=member(A,'fresh');res.setHeader('Content-Type','application/json');let input={};if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;input=JSON.parse(body);}
  if(path==='/api/auth/accounts')res.end(JSON.stringify({accounts:signed?[m]:[]}));else if(path==='/api/auth/login/password'){res.setHeader('Set-Cookie','mock=1; SameSite=Strict; Path=/; HttpOnly');res.end(JSON.stringify(m));}
  else if(path==='/api/session')res.end(JSON.stringify(m));
  else if(path==='/api/auth/linked/resolve'){const v=review(old?'session':'app');const now=Date.now();v.request.createdAt=now-60000;v.request.expiresAt=now+600000;v.session.authAt=old?0:now;v.session.expiresAt=now+24*HOUR;res.end(JSON.stringify(v));}
  else if(path==='/api/auth/step-up/begin')res.end(JSON.stringify({password:true,passkey:false}));
  else if(path==='/api/auth/step-up'){assert.equal(input.method,'password');res.end('{}');}
  else if(path==='/api/auth/linked/approve'){assert.equal(input.code,'BCDFGHJK');assert.equal(req.headers['x-bindle-account'],A);assert.equal(req.headers['x-csrf-token'],'csrf-fresh');res.end(JSON.stringify({expiresAt:input.choice==='ongoing'?null:Date.now()+({'1h':HOUR,'8h':8*HOUR}[input.choice]??input.choice)}));}
  else {res.statusCode=404;res.end('{}');}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const locale of ['en','es'])for(const width of [320,390,1440])for(const colorScheme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme}),page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/approve?lang='+locale+'#request='+R+'&code=URLSECRET');const code=page.locator('input[name=code]');await code.waitFor();assert.equal(await code.inputValue(),'');assert.equal(await page.evaluate(()=>location.hash),'');await code.fill('bcdf ghjk');assert.equal(await page.locator('.approval-code').textContent(),'BCDF-GHJK');
  await page.getByRole('button',{name:locale==='en'?'Continue':'Continuar',exact:true}).click();await page.locator('details summary').click();await page.locator('details input[name=handle]').fill('alice');await page.locator('input[name=password]').fill('mock-password');await page.locator('details button[type=submit]').click();await page.getByRole('heading',{name:locale==='en'?'Review this sign-in':'Revisa este inicio de sesión'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/approve');assert.equal(await page.locator('input[name=duration]:checked').inputValue(),'ongoing');assert.match(await page.locator('main').textContent(),/acme.example/);assert.equal(await context.pages().length,1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.LA4_SCREENSHOTS)await page.screenshot({path:resolve(process.env.LA4_SCREENSHOTS,`approve-${locale}-${width}-${colorScheme}.png`),fullPage:true});
  const approve=page.getByRole('button',{name:locale==='en'?'Approve':'Aprobar',exact:true});await approve.click();await page.getByRole('heading',{name:locale==='en'?'Approved. Return to your device.':'Aprobado. Vuelve a tu dispositivo.'}).waitFor();assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await context.close();
 }
 for(const locale of ['en','es']){
  const context=await browser.newContext({viewport:{width:320,height:1000}}),page=await context.newPage();await page.goto(origin+'/approve?lang='+locale+'&old=1');await page.locator('input[name=code]').fill('BCDF-GHJK');await page.getByRole('button',{name:locale==='en'?'Continue':'Continuar',exact:true}).click();await page.getByRole('button',{name:'@alice',exact:true}).click();await page.locator('.step-up').waitFor();assert.equal(await page.locator('.step-up input[name=password]').getAttribute('autocomplete'),'current-password');await page.locator('.step-up input[name=password]').fill('mock-password');await page.locator('.step-up button[type=submit]').click();await page.getByRole('heading',{name:locale==='en'?'Review this sign-in':'Revisa este inicio de sesión'}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.getByRole('button',{name:locale==='en'?'Approve':'Aprobar',exact:true}).click();await page.getByRole('heading',{name:locale==='en'?'Approved. Return to your device.':'Aprobado. Vuelve a tu dispositivo.'}).waitFor();await context.close();
 }
});

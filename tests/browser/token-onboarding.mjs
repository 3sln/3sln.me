import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/token-onboarding'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {SignupNext,SignUp}=await import('../../apps/web/src/bl/release.mjs');
const {captureOnboardingEntry,takeOnboardingEntry}=await import('../../apps/web/src/providers/onboarding-entry.mjs');
const {default:auth}=await import('../../apps/web/src/ui/release-auth.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
const token='bo1.e30.'+'A'.repeat(43),origin='https://space.example';
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
async function fixture(patch={}){const secrets={onboardingToken:token},calls=[],nav=[];const browser={id:()=>crypto.randomUUID(),now:()=>Date.now(),secret:k=>secrets[k],storeSecret:(k,v)=>secrets[k]=v,savePending:t=>{secrets.pending=t;secrets.onboardingToken=null;},saveSetupChoice(){},captcha:()=>({turnstileToken:'fixture'}),resetCaptcha(){},navigate:u=>nav.push(u)};const api={async get(){throw Error('Unexpected GET');},async request(path,body){calls.push({path,body});if(path.endsWith('/begin'))return {ready:true};if(path.endsWith('/inspect'))return {issuer:origin,expiresAt:Date.now()+60000,names:[{name:'alice',status:'available'},{name:'bob',status:'claimed'}]};if(path.endsWith('/claim'))return {account:{handle:'n.abc',status:'pending'},pendingToken:'limited',readyForRecovery:true};throw Error(path);}};const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),portalContributions:Provider.fromSingleton({}),recoveryFile:Provider.fromSingleton({})}});const write=p=>engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,p)));await write({loading:false,auth:'signup',authMethod:'password',signupMode:'onboarding',signupStep:'onboarding',config:{origin,signupEnabled:false,tokenOnboardingEnabled:true,localDevelopment:true,signupContactRequired:false},route:{kind:'home'},...patch});return {api,browser,calls,secrets,nav,write,read:()=>engine.container.use(['state'],({state})=>state.snapshot()),act:a=>engine.dispatch(a).next('complete'),close:()=>engine.dispose()};}
const render=state=>{const root=document.createElement('main');dodo.reconcile(root,[localize(auth(state),createLocalization({locale:state.locale??'en'}))]);return root;};

test('private fragment is scrubbed before dynamic app import and consumed once without browser storage',()=>{
 let clean;captureOnboardingEntry({pathname:'/token-onboarding',search:'?lang=es',hash:'#token='+token},{replaceState:(_a,_b,url)=>clean=url});assert.equal(clean,'/token-onboarding?lang=es');assert.equal(takeOnboardingEntry(),token);assert.equal(takeOnboardingEntry(),undefined);
 for(const hash of ['#token='+token+'&token='+token,'#token='+token+'&name=admin','#token=bs1.e30.'+'A'.repeat(43)]){captureOnboardingEntry({pathname:'/token-onboarding',search:'',hash},{replaceState(){}});assert.equal(takeOnboardingEntry(),null);}
 const source=readFileSync(new URL('../../apps/web/src/main.mjs',import.meta.url),'utf8');assert(source.indexOf('captureOnboardingEntry(location,history)')<source.indexOf("import('./release.mjs')"));
 captureOnboardingEntry({pathname:'/token-onboarding',search:'?token='+token,hash:''},{replaceState:(_a,_b,url)=>clean=url});assert.equal(clean,'/token-onboarding');assert.equal(takeOnboardingEntry(),null);
 assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
});

test('explicit inspect lists only invitation names, rejects invented/claimed choices and never projects token',async()=>{
 const f=await fixture();try{assert.equal(f.calls.length,0);await f.act(new SignupNext({values:{}}));assert.deepEqual(f.calls.map(c=>c.path),['/api/auth/onboarding/begin','/api/auth/onboarding/inspect']);let s=await f.read();assert.equal(s.signupStep,'name');assert.equal(JSON.stringify(s).includes(token),false);const dom=render(s);assert.deepEqual([...dom.querySelectorAll('option')].map(n=>n.value),['','alice']);assert(!dom.textContent.includes('System account'));await f.act(new SignupNext({values:{onboardingName:'admin'}}));assert.equal((await f.read()).signupStep,'name');await f.act(new SignupNext({values:{onboardingName:'bob'}}));assert.equal((await f.read()).signupStep,'name');await f.act(new SignupNext({values:{onboardingName:'alice'}}));assert.equal((await f.read()).signupStep,'method');assert.equal((await f.read()).onboardingName,'alice');}finally{await f.close();}
});

test('ordinary invitation claim uses scoped endpoint and existing limited recovery setup, with no signupPlan or role',async()=>{
 const f=await fixture({signupStep:'credential',signupTermsAccepted:true,onboardingName:'alice',onboardingNames:[{name:'alice',status:'available'}]});try{await f.act(new SignUp({values:{password:'a long private password'}}));assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/auth/onboarding/claim');assert.equal(f.calls[0].body.name,'alice');assert.equal(f.calls[0].body.onboardingToken,token);assert.equal('signupPlan' in f.calls[0].body,false);assert.equal('role' in f.calls[0].body,false);assert.equal(f.secrets.onboardingToken,null);assert.equal((await f.read()).pending,true);assert.equal((await f.read()).session,null);assert.deepEqual(f.nav,['/recovery/setup']);assert.equal(JSON.stringify(await f.read()).includes('a long private password'),false);}finally{await f.close();}
});

test('ambiguous claim is never automatically or manually resent as another setup',async()=>{
 const f=await fixture({signupStep:'credential',signupTermsAccepted:true,onboardingName:'alice',onboardingNames:[{name:'alice',status:'available'}]});try{f.api.request=async(path,body)=>{f.calls.push({path,body});throw Error('Network outcome unknown');};await f.act(new SignUp({values:{password:'a long private password'}}));await f.act(new SignUp({values:{password:'another private password'}}));assert.equal(f.calls.length,1);const s=await f.read();assert.equal(s.pending,false);assert.equal(s.onboardingClaimUnknown,true);assert.equal(render(s).querySelectorAll('input[name=password]').length,0);assert.match(render(s).textContent,/may have started/);assert.match(render({...s,locale:'es'}).textContent,/configuración ya haya comenzado/);}finally{await f.close();}
});

test('closed host removes normal signup CTA while sign-in and recovery remain; private invited names still work',async()=>{
 const f=await fixture({auth:'login',signupMode:'ordinary'});try{const dom=render(await f.read());assert.equal(dom.querySelector('.explicit-signup-entry'),null);assert.match(dom.textContent,/Sign in with password/);assert.match(dom.textContent,/Use my recovery file/);await f.write({auth:'signup',signupMode:'onboarding'});assert.match(render(await f.read()).textContent,/Use invitation/);}finally{await f.close();}
});

test('late inspection after leaving invitation cannot restore names into unrelated auth state',async()=>{
 const f=await fixture();let finish;try{f.api.request=async path=>path.endsWith('/begin')?{ready:true}:new Promise(resolve=>finish=resolve);const pending=f.act(new SignupNext({values:{}}));while(!finish)await new Promise(resolve=>setTimeout(resolve,0));f.secrets.onboardingToken=null;await f.write({signupMode:'ordinary',auth:'login'});finish({issuer:origin,expiresAt:Date.now()+60000,names:[{name:'alice',status:'available'}]});await pending;assert.equal((await f.read()).onboardingNames,undefined);}finally{await f.close();}
});

test('static landing hides public creation and free marketing after closed-host availability, retaining sign-in',async()=>{
 const landing=new Window({url:'https://space.example/'});try{
  landing.document.body.innerHTML='<span data-public-signup>Free to start</span><section data-signup-panel><a data-signup-action href="/console?signup">Create</a><a href="/console?signin">Sign in</a></section>';
  landing.fetch=async()=>new Response(JSON.stringify({signupEnabled:false,freeSignupOpen:false,paidSignupOpen:false,waitlistEnabled:true,reason:'disabled'}),{headers:{'Content-Type':'application/json'}});
  landing.eval(readFileSync(new URL('../../apps/web/landing.js',import.meta.url),'utf8').replace('/*__LANDING_MESSAGES__*/null',JSON.stringify({en:{disabled:'Private service',closed:'Closed',freeClosed:'Free closed',paid:'Paid',waitlist:'Waitlist'}})));
  for(let i=0;i<30&&!landing.document.querySelector('[data-signup-action]').hidden;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(landing.document.querySelector('[data-signup-action]').hidden,true);assert.equal(landing.document.querySelector('[data-public-signup]').hidden,true);assert.equal(landing.document.querySelector('a[href="/console?signin"]').hidden,false);assert.equal(landing.document.querySelector('a[href*="waitlist"]'),null);
 }finally{await landing.happyDOM.close();}
});

test('late claim result or failure cannot restore setup or clear a replacement account session',async()=>{
 for(const reject of [false,true]){const f=await fixture({signupStep:'credential',signupTermsAccepted:true,onboardingName:'alice',onboardingNames:[{name:'alice',status:'available'}]});let finish;try{
  f.api.request=()=>new Promise((resolve,rejectPromise)=>finish=reject?()=>rejectPromise(Object.assign(Error('stale secret failure'),{status:401})):()=>resolve({pendingToken:'stale-limited',account:{handle:'n.old'}}));
  const pending=f.act(new SignUp({values:{password:'a long private password'}}));while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
  f.secrets.onboardingToken=null;await f.write({auth:'login',signupMode:'ordinary',beamGeneration:2,session:{account:{id:'replacement'}}});finish();await pending;
  const s=await f.read();assert.equal(s.session.account.id,'replacement');assert.equal(s.pending,false);assert.equal(f.secrets.pending,undefined);assert.deepEqual(f.nav,[]);assert.equal(s.error,'');
 }finally{await f.close();}}
});

test('cancellation during begin prevents later inspect and stale failures never clear replacement session',async()=>{
 for(const reject of [false,true]){const f=await fixture();let finish;try{f.api.request=path=>{f.calls.push({path});return new Promise((resolve,rejectPromise)=>finish=reject?()=>rejectPromise(Object.assign(Error('stale'),{status:401})):()=>resolve({ready:true}));};const pending=f.act(new SignupNext({values:{}}));while(!finish)await new Promise(resolve=>setTimeout(resolve,0));f.secrets.onboardingToken=null;await f.write({auth:'login',signupMode:'ordinary',session:{account:{id:'replacement'}}});finish();await pending;assert.equal(f.calls.length,1);assert.equal((await f.read()).session.account.id,'replacement');assert.equal((await f.read()).error,'');}finally{await f.close();}}
});

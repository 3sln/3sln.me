import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','ErrorEvent','Node','Element','location'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)Object.defineProperty(globalThis,name,{value:window[name],configurable:true,writable:true});
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {createAPI}=await import('../../apps/web/src/providers/api.mjs');
const {contactCapture,contactReturn,handoffCapture,parseIntent}=await import('../../apps/web/src/providers/browser.mjs');
const {DiscoverProvider,ContinueWithProvider,ContactAuth,ContactHandoff,StartHandoff,ProceedHandoff,ChooseHandoff,ContinueAsAudience,SendAuthoredMessage,WriteAnother,audienceOrigin}=await import('../../apps/web/src/bl/contact-link.mjs');
const {SaveIntake,RotateChallenge,OpenIntake,CreateContactLink,intakeFrom,tagCandidates}=await import('../../apps/web/src/bl/contact-links.mjs');
const {LoadDeveloperContact}=await import('../../apps/web/src/bl/incoming.mjs');
const {SignOut,CreateRule}=await import('../../apps/web/src/bl/release.mjs');
const {contactPage,handoffView}=await import('../../apps/web/src/ui/release-contact.mjs');
const {developerContact}=await import('../../apps/web/src/ui/release-developer-contact.mjs');
const {intakeDialog}=await import('../../apps/web/src/ui/release-intake.mjs');
const {tagPill}=await import('../../apps/web/src/ui/tag-pill.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
test.after(async()=>{await window.happyDOM.close();for(const name of names)Object.defineProperty(globalThis,name,{value:previous[name],configurable:true,writable:true});});
const origin='https://space.example',contactId='11111111-1111-4111-8111-111111111111',path=`/users/ray/contact/${contactId}`,b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),meta=`${b64({alg:'ES256'})}.${b64({aud:origin+path})}.c2ln`,link=`${origin}${path}?bindle_meta=${meta}`,account={id:'550e8400-e29b-41d4-a716-446655440001',handle:'n.ab'},other={id:'550e8400-e29b-41d4-a716-446655440002',handle:'n.cd'};
const intake={version:1,form:'link',kinds:['one-off'],mimeTypes:['text/plain'],optionalTags:[{id:'topic:bug',label:'Bug report'},{id:'sys:work'}],maxMessageBytes:16384,maxMessages:5,maxBytes:65536,quotaScope:'principal-day',expiresAt:Date.UTC(2027,4,1),conditional:true,policy:'https://3sln.example/policies/developer-contact/v1',intakeRevision:3};
const render=(view,state,locale='en')=>{const root=document.createElement('main');dodo.reconcile(root,[localize(view(state),createLocalization({locale}))]);return root;};
const base={loading:false,locale:'en',view:'inbox',config:{origin,localDevelopment:true,handleOriginHost:'space.example'},brand:{name:'3sln.me',host:'space.example'},route:{kind:'contact',recipient:'ray'}};
const inventory=accounts=>({accounts:accounts.map(a=>({account:a,sessionContext:'ctx-'+a.id.slice(-1),expiresAt:Date.now()+3600000})),revision:'r'.repeat(43),activeOwner:accounts[0].id,limit:5});
async function fixture(patch={},api={}){const secrets={contactEndpoint:link},calls=[],nav=[],saved=[],events=[];let pendingHandoff=null;
 const browser={id:()=>crypto.randomUUID(),now:()=>Date.now(),secret:k=>secrets[k],storeSecret:(k,v)=>secrets[k]=v,navigate:u=>nav.push(u),saveContactHandoff:v=>saved.push(v),takeContactHandoff:()=>{const v=pendingHandoff;pendingHandoff=null;return v;},consumeSubmission(){throw Error('none');},restoreFocus(){},clearOwnerContext(){},cancelDeviceEntry(){},setCaptchaAction(){},installCaptcha(){},focus(){},copy:async()=>{},async messageBody(text,mimeType){const bytes=new TextEncoder().encode(text);return {bytes,mimeType,sha256:Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('base64url')};},pushSubscriptionId:async()=>'P'.repeat(43)};
 const client={get:async p=>{calls.push({path:p});throw Error(p);},request:async(p,b,m)=>{calls.push({path:p,body:b,method:m});throw Error(p);},contactIntake:async()=>intake,contactInspect:async()=>{throw Error('inspect');},contactProfile:async()=>null,...api};
 const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(client),browser:Provider.fromSingleton(browser),portalContributions:Provider.fromSingleton({}),recoveryFile:Provider.fromSingleton({})}});
 for(const name of ['add-contact-opened','contact-handoff-ready'])engine.feed.addEventListener(name,()=>events.push(name));
 const read=()=>engine.container.use(['state'],({state})=>state.snapshot()),write=p=>engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,p)));await write({...base,...patch});
 return {engine,secrets,calls,nav,saved,events,browser,api:client,read,write,handoff:v=>{pendingHandoff=v;},act:a=>engine.dispatch(a).next('complete'),close:()=>engine.dispose()};}
const page={link,intake,profile:null,signup:{open:true,free:true,paid:true,waitlist:false}};

test('capture keeps only the canonical capability; handoff accepts a fragment or a web+bindle intent only',()=>{
 assert.deepEqual(contactCapture({origin,pathname:path,search:`?utm_source=x&bindle_meta=${meta}&bindle_data=${meta}`}),{url:link,data:meta});
 for(const search of [`?bindle_meta=${meta}&bindle_meta=${meta}`,`?sig=a&bindle_meta=${meta}`,'?bindle_data='+meta,''])assert.equal(contactCapture({origin,pathname:path,search}),null);
 assert.equal(contactReturn(link),true);for(const url of ['https://evil.example'+path+'?bindle_meta='+meta,link+'&x=1',`${origin}/console`,link+'#frag',`${origin}${path}?sig=not-a-jws`])assert.equal(contactReturn(url),false);
 assert.deepEqual(handoffCapture({pathname:'/console',search:'',hash:'#contact='+encodeURIComponent(link)+'&intent=send-message'}),{link,intent:'send-message'});
 assert.deepEqual(handoffCapture({pathname:'/console',search:'?intent='+encodeURIComponent('web+bindle://add-contact?contact-url='+encodeURIComponent(link)),hash:''}),{link,intent:'add-contact'});
 assert.deepEqual(handoffCapture({pathname:'/console',search:'?intent='+encodeURIComponent('web+bindle://send-message?contact-url='+encodeURIComponent(link)),hash:''}),{link,intent:'send-message'});
 for(const intent of ['bindle+intent://add-contact?contact-url='+encodeURIComponent(link),'web+bindle://delete?contact-url='+encodeURIComponent(link)])assert.equal(handoffCapture({pathname:'/console',search:'?intent='+encodeURIComponent(intent),hash:''}),null);
 assert.equal(handoffCapture({pathname:'/console',search:'',hash:'#contact='+encodeURIComponent(link)+'&intent=pay'}),null);assert.equal(audienceOrigin(link),origin);
});

test('bindle_intent is untrusted: exact shape, bounded, same-origin or HTTPS contact links; foreign links are flagged',()=>{
 const intent=(i,url)=>'web+bindle://'+i+'?contact-url='+encodeURIComponent(url),q=v=>'?bindle_intent='+encodeURIComponent(v);
 assert.deepEqual(handoffCapture({pathname:'/console',search:q(intent('send-message',link)),hash:''}),{link,intent:'send-message'});
 assert.deepEqual(parseIntent(intent('add-contact','https://other.example'+path+'?bindle_meta='+meta)),{foreign:true,intent:'add-contact'});
 for(const value of [intent('send-message','http://other.example'+path+'?bindle_meta='+meta),intent('send-message',link+'&x=1'),intent('send-message',link)+'&contact-url=x',intent('send-message',link)+'&next=1',intent('send-message',intent('send-message',link)),intent('pay',link),'https://space.example/?contact-url='+encodeURIComponent(link),intent('send-message',link)+'#f',intent('send-message',link+'x'.repeat(8200))])assert.equal(parseIntent(value),null,value);
 assert.equal(handoffCapture({pathname:'/console',search:q(intent('send-message',link))+'&intent='+encodeURIComponent(intent('add-contact',link)),hash:''}),null);
});

test('foreign-provider handle: definite declaration offers an exact hand-off; any failure falls back without redirecting',async()=>{
 const manifest={version:'0',issuer:'https://other.example',login_presentation:['redirect'],authorization_endpoint:'https://other.example/oauth/authorize',token_endpoint:'https://other.example/oauth/token',rpc_endpoint:'https://other.example/rpc',jwks_uri:'https://other.example/jwks',authorization_request_endpoint:'https://other.example/oauth/request',preferences_contract:'https://other.example/preferences',features:{'intents.v1':{intents:['send-message','add-contact'],login_endpoint:'https://other.example/console'},'future-thing.v3':{x:1}}};
 let reply=()=>new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}});const fetched=[];
 const f=await fixture({contactPage:{...page,intake:{...intake,conditional:false}},config:{...base.config,localDevelopment:false}});f.browser.fetcher=async(url,options)=>{fetched.push([url,options]);return reply();};
 try{await f.act(new DiscoverProvider({values:{handle:'alex@other.example'}}));assert.deepEqual(fetched[0][0],'https://other.example/.well-known/bindle/manifest.json');assert.equal(fetched[0][1].credentials,'omit');
  let root=render(contactPage,await f.read());assert.ok(root.textContent.includes('will be sent to'));assert.equal(f.nav.length,0);
  await f.act(new ContinueWithProvider({intent:'send-message'}));assert.equal(f.nav[0],'https://other.example/console?bindle_intent='+encodeURIComponent('web+bindle://send-message?contact-url='+encodeURIComponent(link)));
  for(const broken of [{...manifest,features:{'intents.v2':manifest.features['intents.v1']}},{...manifest,features:{'intents.v1':{...manifest.features['intents.v1'],login_endpoint:'https://evil.example/console'}}},{...manifest,features:{'intents.v1':{...manifest.features['intents.v1'],login_endpoint:'http://other.example/console'}}},{...manifest,features:{'intents.v1':{intents:['other'],login_endpoint:'https://other.example/console'}}},{...manifest,intents_supported:['send-message'],intent_login_endpoint:'https://other.example/console',features:undefined},{...manifest,version:'9'}]){reply=()=>new Response(JSON.stringify(broken),{headers:{'content-type':'application/json'}});f.nav.length=0;await f.act(new DiscoverProvider({values:{handle:'alex@other.example'}}));const s=await f.read();assert.equal(s.contactPage.provider,null);assert.ok(String(s.contactPage.providerError).includes('other.example'));await f.act(new ContinueWithProvider({intent:'send-message'}));assert.equal(f.nav.length,0);assert.ok(render(contactPage,s).querySelector('a.contact-intent'));}
  reply=()=>{throw new TypeError('Failed to fetch');};await f.act(new DiscoverProvider({values:{handle:'alex@other.example'}}));assert.equal((await f.read()).contactPage.provider,null);reply=()=>new Response('',{status:404});await f.act(new DiscoverProvider({values:{handle:'alex@other.example'}}));assert.equal((await f.read()).contactPage.provider,null);assert.equal(f.nav.length,0);
  await f.act(new DiscoverProvider({values:{handle:'me@space.example'}}));assert.deepEqual(f.nav,['/console?signin=1']);assert.deepEqual(f.saved.at(-1),{link,intent:null});
 }finally{await f.close();}
});

test('signed-in bindle_intent arrival goes straight to the prompt; foreign contact links show a clear state',async()=>{
 const f=await fixture({route:{kind:'home'},session:{account}},{get:async()=>inventory([account])});try{f.handoff({link,intent:'send-message'});await f.act(new StartHandoff());const s=await f.read();assert.equal(s.view,'contact-send');assert.equal(f.calls.filter(c=>c.path?.startsWith('/api/links')).length,0);assert.ok(render(handoffView,s).textContent.includes('Continue as'));
  f.handoff({foreign:true,intent:'add-contact'});await f.act(new StartHandoff());assert.ok(render(handoffView,await f.read()).textContent.includes('Contact links on other services can’t be used from here yet.'));assert.equal(f.secrets.addContactURL,undefined);
 }finally{await f.close();}
});

test('public page: no composer or messaging API; intents, sign-in option and capacity states; hidden once signed in',async()=>{
 const f=await fixture({contactPage:page});try{let root=render(contactPage,await f.read());
  assert.equal(root.querySelector('textarea')===null,true);assert.deepEqual([...root.querySelectorAll('form input,form textarea')].map(n=>n.name),['handle']);
  const hrefs=[...root.querySelectorAll('a.contact-intent')].map(a=>a.getAttribute('href'));assert.deepEqual(hrefs,['web+bindle://send-message?contact-url='+encodeURIComponent(link),'web+bindle://add-contact?contact-url='+encodeURIComponent(link)]);
  assert.ok(root.textContent.includes('Sign in or sign up with 3sln.me'));assert.ok(root.textContent.includes('2027'));assert.ok(root.textContent.includes('Conditional contact link'));
  await f.write({contactPage:{...page,signup:{open:true,free:false,paid:true,waitlist:true}}});root=render(contactPage,await f.read());assert.ok(root.textContent.includes('Create a paid account'));assert.equal(root.textContent.includes('Join the waitlist'),false);
  await f.write({contactPage:{...page,signup:{open:false,free:false,paid:false,waitlist:true}}});root=render(contactPage,await f.read());assert.ok([...root.querySelectorAll('a')].some(a=>a.getAttribute('href')==='/console?waitlist=1'));
  await f.act(new ContactAuth({mode:'signin'}));await f.act(new ContactAuth({mode:'paid'}));assert.deepEqual(f.saved,[{link,intent:null},{link,intent:null}]);assert.deepEqual(f.nav,['/console?signin=1','/console?signup=1&plan=paid']);assert.equal(f.calls.length,0);
  await f.write({session:{account}});root=render(contactPage,await f.read());assert.equal(root.textContent.includes('Sign in or sign up'),false);assert.ok(root.textContent.includes('Signed in as \u2068n.ab@space.example\u2069'));
  await f.act(new ContactHandoff({intent:'send-message'}));assert.equal(f.nav.at(-1),'/console#contact='+encodeURIComponent(link)+'&intent=send-message');assert.equal(f.calls.length,0);
  await f.write({contactPage:{...page,intake:{...intake,mimeTypes:['application/vnd.3sln.web-archive+json']}}});root=render(contactPage,await f.read());assert.ok(root.textContent.includes('This link accepts content from apps, not written messages.'));assert.equal([...root.querySelectorAll('button')].some(b=>b.textContent==='Send a message'),false);assert.equal(root.innerHTML.includes('send-message'),false);
 }finally{await f.close();}
});

test('console handoff: several accounts choose first, then send-message loads intake; add-contact prefills; signed out re-saves',async()=>{
 const f=await fixture({route:{kind:'home'},session:{account}},{get:async p=>p==='/api/auth/accounts'?inventory([account,other]):(()=>{throw Error(p);})()});
 try{f.handoff({link,intent:'send-message'});await f.act(new StartHandoff());let s=await f.read();assert.equal(s.accountPicker,true);assert.equal(s.handoff.choosing,true);assert.equal(s.view,'inbox');assert.equal(f.secrets.contactEndpoint,link);
  await f.act(new ProceedHandoff());s=await f.read();assert.equal(s.view,'contact-send');assert.equal(s.accountPicker,false);assert.deepEqual(s.handoff.intake,intake);assert.equal(s.handoff.origin,origin);
  f.api.get=async()=>inventory([account]);f.handoff({link,intent:'add-contact'});await f.act(new StartHandoff());assert.equal(f.secrets.addContactURL,link);assert.equal((await f.read()).handoff,null);assert.deepEqual(f.events,['add-contact-opened']);
  f.handoff({link,intent:null});await f.act(new StartHandoff());assert.equal((await f.read()).view,'contact-send');assert.ok(render(handoffView,await f.read()).textContent.includes('What would you like to do'));await f.act(new ChooseHandoff({intent:'send-message'}));assert.equal((await f.read()).handoff.intent,'send-message');
  f.handoff({lost:true});await f.act(new StartHandoff());assert.match((await f.read()).notice,/expired/);
  await f.write({session:null,handoff:null});f.handoff({link,intent:'add-contact'});await f.act(new StartHandoff());assert.deepEqual(f.saved.at(-1),{link,intent:'add-contact'});assert.equal((await f.read()).auth,'login');
 }finally{await f.close();}
});

test('console conditional: disclosure names the aud origin before signing; respond only on click; ineligible names the account',async()=>{
 const inspected=[];const f=await fixture({route:{kind:'home'},view:'contact-send',session:{account},handoff:{intent:'send-message',origin,intake}},{contactInspect:async(endpoint,data)=>{inspected.push([endpoint,data]);return {audience:{state:'eligible'}};}});
 try{f.api.request=async(p,b)=>{f.calls.push({path:p,body:b});return {data:'eyJk.eyJl.c2ln'};};
  let root=render(handoffView,await f.read());assert.ok(root.textContent.includes(`Continuing reveals your handle and identity (⁨n.ab@space.example⁩) to ⁦${origin}⁩`));assert.equal(root.querySelector('textarea')===null,true);assert.equal(f.calls.length,0);
  await f.act(new ContinueAsAudience());assert.deepEqual(f.calls,[{path:'/api/links/respond',body:{link}}]);assert.deepEqual(inspected,[[link,'eyJk.eyJl.c2ln']]);
  root=render(handoffView,await f.read());assert.ok(root.querySelector('textarea'));assert.ok(root.textContent.includes('Bug report'));assert.ok(root.textContent.includes('Work'));
  render(handoffView,await f.read(),'es');
  await f.write({session:{account:other}});assert.equal(render(handoffView,await f.read()).querySelector('textarea')===null,true);
  await f.write({session:{account},handoff:{...(await f.read()).handoff,audience:{state:'ineligible',reason:'paid-required',owner:account.id}}});root=render(handoffView,await f.read());assert.ok(root.textContent.includes('Checked as ⁨n.ab@space.example⁩'));assert.ok(root.textContent.includes('paid accounts'));assert.ok(root.textContent.includes('Try again'));
 }finally{await f.close();}
});

test('authored send: envelope then exactly two public multipart parts without credentials; sent state keyed to the account',async t=>{
 const prior=globalThis.fetch;t.after(()=>globalThis.fetch=prior);const fetched=[];
 globalThis.fetch=async(url,options)=>{fetched.push({url,options});return new Response(JSON.stringify({receipt:{payload:{messageId:'m'},proof:{}}}),{status:202,headers:{'content-type':'application/json'}});};
 const real=createAPI();const f=await fixture({route:{kind:'home'},view:'contact-send',session:{account},handoff:{intent:'send-message',origin,intake:{...intake,conditional:false}}},{contactDeliver:real.contactDeliver.bind(real),contactPublic:real.contactPublic.bind(real),parse:real.parse.bind(real)});
 try{let envelopeBody;f.api.request=async(p,b)=>{f.calls.push({path:p,body:b});envelopeBody=b;return {envelope:{payload:{operationId:b.operationId,content:{mimeType:b.mimeType,byteLength:b.byteLength,sha256:b.sha256}},proof:{alg:'ES256'}}};};
  const values={subject:'Hello',text:'Hi there',tags:['topic:bug']};await f.act(new SendAuthoredMessage({values}));
  assert.equal(f.calls[0].path,'/api/links/envelope');assert.equal(envelopeBody.link,link);assert.deepEqual(envelopeBody.optionalTags,['topic:bug']);assert.equal(envelopeBody.byteLength,8);assert.ok(Number.isSafeInteger(envelopeBody.createdAt));
  const sent=fetched[0];assert.equal(fetched.length,1);assert.equal(sent.url,link);assert.equal(sent.options.credentials,'omit');assert.equal(sent.options.referrerPolicy,'no-referrer');assert.equal(sent.options.headers['Idempotency-Key'],envelopeBody.operationId);
  const parts=[...sent.options.body.entries()];assert.deepEqual(parts.map(([n])=>n),['envelope','message']);assert.equal(parts[0][1].type,'application/json');assert.equal(parts[1][1].type,'text/plain');assert.equal(await parts[1][1].text(),'Hi there');
  let root=render(handoffView,await f.read());assert.ok(root.querySelector('.contact-sent[role=status]'));assert.ok(root.textContent.includes('Sent as ⁨n.ab@space.example⁩'));
  await f.write({session:{account:other}});assert.equal(render(handoffView,await f.read()).querySelector('.contact-sent')===null,true);await f.write({session:{account}});
  await f.act(new WriteAnother());f.calls.length=0;await f.act(new SendAuthoredMessage({values:{...values,tags:['topic:secret']}}));assert.equal(f.calls.length,0);assert.match(String((await f.read()).error),/tags changed/);
 }finally{await f.close();}
});

test('identical retry keeps its operation ID and creation time; Retry-After is localized',async()=>{
 const seen=[];const f=await fixture({route:{kind:'home'},session:{account},handoff:{intent:'send-message',intake:{...intake,conditional:false}}},{contactDeliver:async()=>{throw Object.assign(Error('x'),{code:'quota_exceeded',retryAfter:120});}});
 try{f.api.request=async(p,b)=>{seen.push(b);return {envelope:{payload:{operationId:b.operationId,content:{mimeType:b.mimeType,sha256:b.sha256}}}};};const values={subject:'S',text:'Body'};await f.act(new SendAuthoredMessage({values}));await f.act(new SendAuthoredMessage({values}));assert.equal(seen[0].operationId,seen[1].operationId);assert.equal(seen[0].createdAt,seen[1].createdAt);const error=(await f.read()).error;assert.equal(error.source,'This link’s message limit has been reached. Try again {time}.');assert.equal(error.variables.time,'in 2 minutes');await f.act(new SendAuthoredMessage({values:{...values,text:'Other'}}));assert.notEqual(seen[2].operationId,seen[0].operationId);}finally{await f.close();}
});

test('intake editor: revision CAS, conflict reload, other-locale labels kept, no system or registry label defaults; rotation',async()=>{
 const contact={id:contactId,name:'Dev',active:true,form:'link',conditional:true,intake:{revision:3,autoTags:['contact:developer'],optionalTags:['topic:bug','sys:work'],labels:{'topic:bug':{en:'Bug report',es:'Error'}}}};
 const f=await fixture({route:{kind:'home'},session:{account},data:{contacts:[contact],tagLabels:{revision:1,labels:{'t.abc':'Clients'}}}});
 try{const puts=[];let conflict=true;f.api.get=async p=>p.endsWith('/intake')?{...contact.intake,revision:conflict?3:4}:{contacts:[contact],tagLabels:{revision:1,labels:{}}};f.api.request=async(p,b,m)=>{if(m==='PUT'){puts.push(b);if(conflict){conflict=false;throw Object.assign(Error('conflict'),{code:'intake_conflict',status:409});}return b;}if(p.endsWith('/rotate'))return {url:link};throw Error(p);};
  await f.act(new OpenIntake({id:contactId}));const state=await f.read();const root=render(s=>intakeDialog(s).body,state);assert.ok(root.querySelector('select[name="tag:t.abc"]'));assert.equal(root.querySelector('select[name="tag:topic:bug"]').value,'optional');assert.equal(root.querySelector('input[name="label:t.abc"]').value,'');assert.equal(root.querySelector('input[name="label:sys:work"]')===null,true);assert.equal(root.querySelector('.intake-count-value').textContent,'3');
  const values={'tag:contact:developer':'auto','tag:topic:bug':'optional','label:topic:bug':'Bug','tag:t.abc':'optional','label:t.abc':'Client work','tag:sys:work':'optional'};
  await f.act(new SaveIntake({values}));assert.equal(puts[0].revision,3);assert.match((await f.read()).error,/changed in another window/);assert.equal((await f.read()).modal.intake.revision,4);
  await f.act(new SaveIntake({values}));assert.equal(puts[1].revision,4);assert.deepEqual(puts[1].optionalTags,['topic:bug','sys:work','t.abc']);assert.deepEqual(puts[1].labels,{'topic:bug':{es:'Error',en:'Bug'},'t.abc':{en:'Client work'}});assert.equal((await f.read()).modal,null);
  assert.throws(()=>intakeFrom({'tag:sys:work':'auto',optionalTagsExtra:'sys:work'},tagCandidates(state,null)),/not both/);assert.throws(()=>intakeFrom({autoTagsExtra:'sys:fake'},[]),/reserved/);
  await f.write({modal:{kind:'rotate',contact}});assert.ok(render(s=>intakeDialog(s).body,await f.read()).textContent.includes('Cancel'));await f.act(new RotateChallenge());assert.equal((await f.read()).modal.kind,'share');assert.equal((await f.read()).modal.contact.url,link);
 }finally{await f.close();}
});

test('new contact links use bindle_meta issuance unless conversation invitations need the legacy form',async()=>{
 const f=await fixture({route:{kind:'home'},session:{account},data:{collections:[{id:'c',active:true}],contacts:[]}});try{const posts=[];f.api.get=async()=>({contacts:[]});f.api.request=async(p,b)=>{posts.push([p,b]);return {id:'x',url:link};};const values={name:'Friends',mimeType:'text/plain',days:'30',maxMessages:'10',maxMessageBytes:'1000','tag:sys:personal':'auto'};
  await f.act(new CreateContactLink({values}));assert.equal(posts[0][0],'/api/contact-links');assert.deepEqual(posts[0][1].autoTags,['sys:personal']);assert.equal(posts[0][1].collections,undefined);
  await f.act(new CreateContactLink({values:{...values,conversationInvites:'on'}}));assert.equal(posts[1][0],'/api/contacts');assert.deepEqual(posts[1][1].requiredTags,['sys:personal']);
 }finally{await f.close();}
});

test('developer contact shows the shared conditional link and current eligibility',async()=>{
 const f=await fixture({route:{kind:'home'},session:{account}});try{f.api.get=async()=>({available:true,url:link,expiresAt:Date.now()+86400000,policy:intake.policy,recipientBadge:{role:'developer'},eligibility:{state:'ineligible',reason:'paid-required'}});await f.act(new LoadDeveloperContact());const state=await f.read();assert.equal(state.developerContact.eligibility.state,'ineligible');assert.equal(f.secrets.developerContactURL.url,link);assert.equal(JSON.stringify(state).includes(meta),false);
  const root=render(developerContact,state);assert.ok(root.textContent.includes('not currently eligible'));assert.ok(root.textContent.includes('Developer contact is currently available to paid accounts.'));assert.ok(root.textContent.includes('Open developer contact'));assert.equal(root.textContent.includes('today'),false);
  f.api.get=async()=>({available:true,url:link.replace('bindle_meta','sig'),eligibility:{state:'eligible'}});await f.act(new LoadDeveloperContact());assert.match((await f.read()).error,/not available/);
 }finally{await f.close();}
});

test('tag pills render owner labels literally and system tags with system and suspected classes',()=>{
 const state={data:{tagLabels:{labels:{'t.abc':'Clients'}}}},root=document.createElement('div');dodo.reconcile(root,[localize(tagPill('t.abc',state),createLocalization({locale:'es'})),localize(tagPill('sys:spam',state),createLocalization({locale:'en'})),localize(tagPill('sys:suspected.spam',state),createLocalization({locale:'en'}))]);
 const [user,system,suspected]=root.children;assert.equal(user.textContent,'Clients');assert.equal(user.getAttribute('translate'),'no');assert.ok(system.classList.contains('system-tag'));assert.equal(system.classList.contains('suspected-tag'),false);assert.ok(suspected.classList.contains('suspected-tag'));assert.equal(suspected.textContent,'Suspected Spam');
});

test('rules carry addTags/removeTags and sign-out removes this device push subscription',async()=>{
 const f=await fixture({route:{kind:'home'},session:{account},data:{rules:[]}});try{const calls=[];f.api.request=async(p,b,m)=>{calls.push({path:p,body:b,method:m});return {};};f.api.get=async()=>({rules:[]});
  await f.act(new CreateRule({values:{name:'R',addTags:'a, b',removeTags:'sys:suspected.social',classification:'unclassified'}}));const rule=calls[0].body.rules[0];assert.deepEqual(rule.actions.addTags,['a','b']);assert.deepEqual(rule.actions.removeTags,['sys:suspected.social']);assert.equal(rule.actions.tags,undefined);
  await f.act(new SignOut());assert.deepEqual(calls.at(-1),{path:'/api/auth/logout',body:{pushSubscription:'P'.repeat(43)},method:undefined});
 }finally{await f.close();}
});

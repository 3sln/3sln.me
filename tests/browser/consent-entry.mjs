// Entry/engine integration over the actual dodo projection, with member-scoped
// HTTP inventory and an injected IA transport. No production routes are added.
import test from 'node:test';import assert from 'node:assert/strict';import {Window} from 'happy-dom';
const win=new Window({url:'https://provider.example/oauth/authorize?entry='+'E'.repeat(43)}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData','HTMLInputElement','MouseEvent'];const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=win[name];
test.after(async()=>{await win.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});
const {startEntryPage}=await import('../../apps/web/src/bl/authorize-entry-page.mjs'),{createConsentExperience,ConsentWalkthroughAction}=await import('../../apps/web/src/bl/authorize-entry-consent.mjs'),{EntryAction}=await import('../../apps/web/src/bl/authorize-entry.mjs'),{fixture,descriptions,fragment}=await import('./consent-fixtures.mjs');const described=await descriptions(),owner='550e8400-e29b-41d4-a716-446655440001',issuer='https://provider.example';
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out.');};
async function pageHarness(t,{intent='grant-more',noDelta=false}={}){
 const f=fixture({intent,scenario:'one'});if(intent==='configure')delete f.entry.requests;else f.entry.requests=[{fragment,fields:['files'],purpose:'Files'}];if(noDelta)f.facts.items=[];
 const calls=[],nav=[],root=document.createElement('div');document.body.replaceChildren(root);const target=new EventTarget(),window=Object.assign(target,{document,location:win.location,opener:null,setInterval:()=>0,clearInterval(){},BroadcastChannel:undefined});document.hasFocus=()=>true;
 const fetch=async(path,options={})=>{calls.push({path,options});let value;if(path.startsWith('/api/oauth/entries/')&&!path.endsWith('/select'))value={entry:f.entry,pageToken:'T'.repeat(43)};else if(path==='/api/auth/accounts')value={accounts:[{account:{id:owner,handle:'ray'},sessionContext:'session-ray'}]};else if(path==='/api/session')value={authenticated:true,account:{id:owner},sessionContext:'session-ray',csrfToken:'csrf-ray'};else if(path.endsWith('/select'))value={requestId:owner+'.'+'R'.repeat(43),...noDelta?{completed:{redirectUri:'https://tasks.example/callback?state=S&iss='+encodeURIComponent(issuer)+'&code=C'}}:{incremental:{intent,requests:intent==='configure'?[]:[{fragment}]}}};else value={authenticated:true,client:f.entry.client,requests:intent==='configure'?[]:[{fragment}]};return new Response(JSON.stringify(value),{status:200});};
 const browser={win:window,origin:issuer,location:{pathname:'/oauth/authorize',search:'?entry='+'E'.repeat(43)},framed:()=>false,sandboxed:()=>false,now:()=>Date.now(),replace:href=>nav.push({replace:href}),assign:href=>nav.push({assign:href}),close:()=>nav.push({close:true})};
 const transport=[];const page=startEntryPage({root,win:window,fetch,browser,consentExperience:()=>createConsentExperience({config:{INCREMENTAL_AUTH_ENABLED:true},prepare:()=>f.facts,describe:input=>described.model(input),transport:Object.fromEntries(['decision','configure','suppress'].map(kind=>[kind,async detail=>{transport.push({kind,...detail});return {redirectUri:'https://tasks.example/callback?state=S&iss='+encodeURIComponent(issuer)+(intent==='configure'?'&result='+(detail.declined?'unchanged':'configured'):'&code=C')};}]))})});t.after(()=>page.dispose());await until(()=>page.model.accounts?.length);await page.engine.dispatch(new EntryAction('continue',{owner})).next('complete');
 const act=async(kind,detail)=>page.engine.dispatch(new ConsentWalkthroughAction(kind,detail)).next('complete');return {page,root,nav,calls,transport,act};
}
test('member-scoped entry opens CX-2 and a partial decision waits for the armed return surface before navigation',async t=>{
 const h=await pageHarness(t);assert.equal(h.page.model.phase,'consent');assert(h.root.querySelector('[data-consent-step=review]'));assert.equal(h.root.querySelector('#consent-step-title').textContent,'Tasks is asking for more access');assert.equal(h.calls.find(c=>c.path.endsWith('/select')).options.headers['X-Bindle-Account'],owner);
 await h.act('include',{id:'files',value:true});await h.act('allow');assert.equal(h.transport.length,1);assert.equal(h.nav.length,0);assert.equal(h.page.model.walkthrough.step,'recap');await h.act('return');await until(()=>h.nav.length);assert.equal(h.page.model.phase,'returning');assert.match(h.nav[0].assign,/code=C/);
});
test('configure has a settings-only callback without a code and declining does not use the legacy denial endpoint',async t=>{
 const h=await pageHarness(t,{intent:'configure'});await h.act('bulk');await h.act('save');assert.equal(h.transport[0].kind,'configure');assert.equal(h.transport[0].approved,undefined);await h.act('return');await until(()=>h.nav.length);const callback=new URL(h.nav[0].assign);assert.equal(callback.searchParams.get('result'),'configured');assert.equal(callback.searchParams.has('code'),false);
});
test('no delta completes without another consent surface and sends no existing grants back as new authority',async t=>{
 const h=await pageHarness(t,{noDelta:true});assert.equal(h.transport.length,0);assert.equal(h.calls.some(c=>c.path.startsWith('/api/oauth/requests/')),false);assert.equal(h.nav.length,1);assert.equal(h.page.model.phase,'returning');
});

// IA-R2: a login on an existing connection that asks for more renders the provider-marked additions apart from what
// is already granted, in en and es; a malformed marking renders nothing (the server still enforces the delta).
async function loginHarness(t,{locale='en',incrementalLogin}={}){
 const extra=fragment+'/extra',client={id:'https://tasks.example/client',name:'Tasks',origin:'https://tasks.example'};
 const entry={client,intent:'login',redirectUri:'https://tasks.example/callback',requests:[{fragment,required:true,purpose:'Files',fields:['theme']},{fragment:extra,required:true,purpose:'More',fields:['color']}],nonce:'N'.repeat(22),delivery:'redirect',presentation:'redirect',expiresAt:Date.now()+600000};
 const card=(id,field,title)=>({fragment:id,required:false,purpose:'Purpose',fields:[field],schema:{title,description:'Settings',publisher:'https://settings.example',fields:{[field]:{title:field==='theme'?'Theme':'Colour',type:'string',maxLength:20}}},values:{[field]:'x'},resources:[],affectedApps:[],methods:{},revision:'r1'});
 const calls=[],nav=[],root=document.createElement('div');document.body.replaceChildren(root);
const target=new EventTarget(),window=Object.assign(target,{document,location:win.location,opener:null,setInterval:()=>0,clearInterval(){},BroadcastChannel:undefined});document.hasFocus=()=>true;
 const fetch=async(path,options={})=>{calls.push({path,options});let value;if(path.startsWith('/api/oauth/entries/')&&!path.endsWith('/select'))value={entry,pageToken:'T'.repeat(43)};else if(path==='/api/auth/accounts')value={accounts:[{account:{id:owner,handle:'ray'},sessionContext:'session-ray'}]};else if(path==='/api/session')value={authenticated:true,account:{id:owner},sessionContext:'session-ray',csrfToken:'csrf-ray'};else if(path.endsWith('/select'))value={requestId:owner+'.'+'R'.repeat(43),incrementalLogin};else value={authenticated:true,client,requests:[card(fragment,'theme','Shared settings'),card(extra,'color','Calendar colours')]};return new Response(JSON.stringify(value),{status:200});};
 const browser={win:window,origin:issuer,location:{pathname:'/oauth/authorize',search:'?entry='+'E'.repeat(43)},framed:()=>false,sandboxed:()=>false,now:()=>Date.now(),replace:href=>nav.push({replace:href}),assign:href=>nav.push({assign:href}),close:()=>nav.push({close:true})};
 const page=startEntryPage({root,win:window,fetch,browser,preferredLocale:locale});await until(()=>page.model.phase==='consent'||page.model.phase==='choose');
 if(page.model.phase==='choose'){page.engine.dispatch(new EntryAction('continue',{owner}));await until(()=>page.model.phase==='consent');}
 return {page,root,extra};
}
for(const [locale,added,existing] of [['en','New access requested by Tasks','Already granted to Tasks'],['es','Nuevo acceso solicitado por Tasks','Ya concedido a Tasks']])
 test(`login deltas on an existing connection are marked as new access, separate from granted access (${locale})`,async t=>{
  const h=await loginHarness(t,{locale,incrementalLogin:{additions:[{fragment:fragment+'/extra',delta:{fields:['color'],methods:{}}}],predeclined:[]}});
  const additions=[...h.root.querySelectorAll('[data-consent-addition]')],existingNotes=[...h.root.querySelectorAll('[data-consent-existing]')];
  assert.equal(additions.length,1);assert.equal(existingNotes.length,1);assert.match(additions[0].textContent,new RegExp(added));assert.match(additions[0].textContent,/Colour/);assert.match(existingNotes[0].textContent,new RegExp(existing));
  assert.equal(additions[0].getAttribute('role'),'note');assert(additions[0].closest('section').textContent.includes('Calendar colours'),'the marking sits on the added card');
 });
test('a malformed or absent login marking renders no addition notes',async t=>{
 for(const incrementalLogin of [undefined,{additions:[{fragment:'javascript:x',delta:{fields:[],methods:{}}}],predeclined:[]},{additions:'x'}]){const h=await loginHarness(t,{incrementalLogin});assert.equal(h.root.querySelectorAll('[data-consent-addition],[data-consent-existing]').length,0);}
});

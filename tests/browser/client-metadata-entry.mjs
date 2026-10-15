// UI-state checks for unreviewed (client-id-metadata.v1) apps on the provider entry page and the legacy consent page
// helpers: real dodo/ngin/bab modules in happy-dom with a scripted same-origin server. The verified origin must be the
// app's label everywhere; the document's self-declared name appears only as marked, isolated, unverified text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://provider.example/oauth/authorize?entry='+'E'.repeat(43)}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData','HTMLInputElement','MouseEvent'];
const previous=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=window[n];
test.after(async()=>{await window.happyDOM.close();for(const n of names)globalThis[n]=previous[n];});
const {validEntryView}=await import('../../apps/web/src/bl/authorize-entry.mjs');
const {startEntryPage}=await import('../../apps/web/src/bl/authorize-entry-page.mjs');
const issuer='https://provider.example',app='https://app.example',clientId=app+'/bindle-client.json',entryId='E'.repeat(43),nonce='N'.repeat(22),pageToken='T'.repeat(43);
const A='550e8400-e29b-41d4-a716-446655440001';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const view=client=>({entry:{client,redirectUri:app+'/callback',intent:'login',requests:[],presentation:'popup',delivery:'popup',nonce,expiresAt:Date.now()+600000},pageToken});
const until=async(check,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=check();if(value)return value;await sleep(10);}throw new Error('Timed out waiting for state.');};
function harness(entry){
 const root=document.createElement('div');document.body.replaceChildren(root);
 const routes=[[`GET /api/oauth/entries/${entryId}`,()=>entry],['GET /api/auth/accounts',()=>({accounts:[{account:{id:A,handle:'alex'},sessionContext:'ca',expiresAt:Date.now()+3600000}]})],['GET /api/session',()=>({authenticated:true,account:{id:A,handle:'alex'},csrfToken:'csrf',sessionContext:'ca'})]];
 const fetch=async(path,options={})=>{const key=`${options.method??'GET'} ${path}`;for(const [match,reply] of routes)if(match===key)return json(await reply());return json({error:'not_found'},404);};
 const win=Object.assign(new EventTarget(),{document,location:window.location,opener:null,BroadcastChannel:undefined,setInterval:()=>0,clearInterval(){},open(){return null;}});window.document.hasFocus=()=>true;
 const browser={win,origin:issuer,get location(){return {pathname:'/oauth/authorize',search:`?entry=${entryId}`};},framed:()=>false,sandboxed:()=>false,now:()=>Date.now(),replace(){},assign(){},close(){}};
 startEntryPage({root,preferredLocale:'en',win,fetch,browser});return {root};
}

test('entry view validation: an unreviewed client is named by its verified host, never by its claim',()=>{
 const parsed=validEntryView(view({id:clientId,name:'app.example',origin:app,reviewed:false,claimedName:'Your Bank'}),issuer);
 assert.deepEqual({...parsed.client},{id:clientId,name:'app.example',origin:app,reviewed:false,claimedName:'Your Bank'});
 // Even if a server sent a claimed name as `name`, the model labels the app by host.
 assert.equal(validEntryView(view({id:clientId,name:'Your Bank',origin:app,reviewed:false}),issuer).client.name,'app.example');
 for(const client of [{id:clientId,name:'x',origin:app,reviewed:true},{id:clientId,name:'x',origin:app,claimedName:'Reviewed claim'},{id:clientId,name:'x',origin:app,reviewed:false,claimedName:'x'.repeat(101)},{id:clientId,name:'x',origin:app,reviewed:false,claimedName:7}])
  assert.throws(()=>validEntryView(view(client),issuer),{code:'invalid_entry'},JSON.stringify(client));
});

test('entry page: the unreviewed app shows its verified website first, a review warning and the unverified name',async()=>{
 const h=harness(view({id:clientId,name:'app.example',origin:app,reviewed:false,claimedName:'Your Bank — Official'}));
 await until(()=>h.root.querySelector('.account-row'));
 const title=h.root.querySelector('h1').textContent;assert.match(title,/Sign in to .*app\.example/);assert.doesNotMatch(title,/Your Bank/);
 const origin=h.root.querySelector('[data-unreviewed-client]');assert.ok(origin);assert.match(origin.textContent,/provider\.example has not reviewed this app\. Continue only if you trust .*app\.example/);
 const claimed=h.root.querySelector('[data-claimed-name]');assert.match(claimed.textContent,/Name the app gives itself \(not verified\): .*Your Bank — Official/);
 assert.equal(claimed.querySelector('[translate=no]').textContent,'⁨Your Bank — Official⁩','the claim is bidi-isolated text, never markup');
 assert.ok(h.root.textContent.indexOf('App website: ')<h.root.textContent.indexOf('Name the app gives itself'),'the verified origin comes first');
});

test('entry page: a reviewed client keeps its registered name and shows no unreviewed warning',async()=>{
 const h=harness(view({id:app+'/client',name:'Example app',origin:app}));
 await until(()=>h.root.querySelector('.account-row'));
 assert.match(h.root.querySelector('h1').textContent,/Sign in to .*Example app/);assert.equal(h.root.querySelector('[data-unreviewed-client]'),null);assert.equal(h.root.querySelector('[data-claimed-name]'),null);
});

test('entry view validation counts claimed names in code points, matching the server',()=>{
 assert.equal(validEntryView(view({id:clientId,name:'app.example',origin:app,reviewed:false,claimedName:'\u{1F600}'.repeat(100)}),issuer).client.claimedName.length,200);
});

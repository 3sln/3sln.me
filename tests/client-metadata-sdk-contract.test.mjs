// SDK contract for client-id-metadata.v1: packages/sdk uses `clientMetadataUrl` with a provider that declares the
// feature, against the real entry, token and revocation handlers and a fake egress port serving the app's document.
// The provider page is simulated over real HTTP (view, select, inspect, decide) as in the entry SDK contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../packages/sdk/src/flows.mjs';
import {memoryStorage} from '../packages/sdk/src/testing.mjs';
import {handleCallback} from '../packages/sdk/src/callback.mjs';
import {CLIENT_METADATA_FEATURE} from '../packages/federation/client-metadata.mjs';
import {issuer,appOrigin,clientId,redirectUri,metadata,cimdProvider} from './client-metadata-helpers.mjs';
const host=new URL(issuer).host;
const post=(p,url,body,headers={})=>p.fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const pageHeaders=(view,extra={})=>({Origin:issuer,'Sec-Fetch-Site':'same-origin','X-Bindle-Entry-Token':view.pageToken,...extra});
async function providerPage(p,url,seen){
 const entryId=new URL(url).searchParams.get('entry'),view=await(await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}})).json();seen.push(view.entry.client);
 const session=p.signIn(),headers=pageHeaders(view,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce},headers);
 return (await(await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,approved:[]},headers)).json()).redirectUri;
}
function harness(p){
 const opened=[],seen=[],win={navigator:{language:'en'},location:{href:`${appOrigin}/`,assign(){}},matchMedia:()=>({matches:false})};
 win.open=(url,target,features)=>{const popup={url,target,features,closed:false,opener:win,document:{title:'',body:{textContent:''}},close(){popup.closed=true;},focus(){},location:{}};
  Object.defineProperty(popup.location,'href',{get:()=>popup.url,set:value=>{popup.url=value;if(new URL(value).origin!==issuer)return;queueMicrotask(async()=>{const callback=await providerPage(p,value,seen);popup.result=await handleCallback({location:{href:callback},history:{replaceState(){}},storage:memoryStorage(),BroadcastChannel:globalThis.BroadcastChannel,render:false,close:false});});}});
  opened.push(popup);return popup;};
 // The reference provider has no popup pages yet: declare popup so the SDK drives the simulated relay (as the entry contract does).
 const fetcher=async(input,init)=>{const response=await p.fetch(input,init),url=new URL(input instanceof Request?input.url:input);if(url.pathname!=='/.well-known/bindle/manifest.json'||!response.ok)return response;const manifest=await response.json();return new Response(JSON.stringify({...manifest,login_presentation:['redirect','popup']}),{status:200,headers:{'Content-Type':'application/json'}});};
 return {win,opened,seen,fetcher};
}

test('SDK contract: clientMetadataUrl signs in with no registration when the provider declares client-id-metadata.v1',async()=>{
 const p=await cimdProvider({documents:{[clientId]:metadata({client_name:'Example App'})},withReviewed:false}),{win,seen,fetcher}=harness(p);
 const session=createSession({clientMetadataUrl:clientId,redirectUri,fetcher,storage:memoryStorage(),history:{replaceState(){}},window:win,defaultHost:host});
 await session.loadCapabilities();
 assert.deepEqual(await session.signIn({identity:'alex'}),{outcome:'completed'});assert.equal(session.state,'signed-in');assert.equal(session.session.subject,p.accounts[0].subject);
 assert.equal(session.client.session.client_id,clientId);
 // The provider page saw the verified origin as the label and the claimed name only as unverified text.
 assert.deepEqual(seen[0],{id:clientId,name:'app.example',origin:appOrigin,reviewed:false,claimedName:'Example App'});
 assert.deepEqual(p.egress.calls.map(c=>c.url),[clientId]);
 assert.deepEqual(await session.signOut({revoke:true}),{outcome:'completed'});
});

test('SDK contract: without the declaration the SDK reports an unregistered client and nothing is fetched',async()=>{
 const p=await cimdProvider({enabled:false}),{win,opened,fetcher}=harness(p);
 const manifest=await(await p.fetch(`${issuer}/.well-known/bindle/manifest.json`)).json();assert.equal(manifest.features?.[CLIENT_METADATA_FEATURE],undefined);
 const session=createSession({clientMetadataUrl:clientId,redirectUri,fetcher,storage:memoryStorage(),history:{replaceState(){}},window:win,defaultHost:host});
 await session.loadCapabilities();const result=await session.signIn({identity:'alex'});
 assert.equal(result.code,'unregistered-client',JSON.stringify(result));assert.equal(opened.length,0);assert.equal(p.egress.calls.length,0);
});

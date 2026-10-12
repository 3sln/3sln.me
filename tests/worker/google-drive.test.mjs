import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';

const start='/api/integrations/google/start',complete='/api/integrations/google/complete',callback='/api/integrations/google/callback';
async function signed(h){const {result:owner,cookie}=await h.signup();return {owner,cookie,headers:{Origin:h.origin,Cookie:cookie,'X-CSRF-Token':owner.csrfToken}};}
async function read(response,status=200){const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}

test('actual Worker Drive endpoints require current owner, Origin and CSRF before OAuth state changes',async t=>{
 const h=await createHarness({bindings:{GOOGLE_CLIENT_ID:'dummy-client',GOOGLE_CLIENT_SECRET:'dummy-secret'}});t.after(()=>h.close());const {headers,owner}=await signed(h);
 const config=await read(await h.request('/api/config'));assert.equal(config.providers.google.enabled,true);
 for(const route of [start,complete]){
  assert.equal((await h.request(route,{method:'POST',headers:{Origin:h.origin},value:{}})).status,401);
  assert.equal((await h.request(route,{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},value:{}})).status,403);
  assert.equal((await h.request(route,{method:'POST',headers:{...headers,Origin:'https://attacker.example'},value:{}})).status,403);
  const noOrigin={...headers};delete noOrigin.Origin;assert.equal((await h.request(route,{method:'POST',headers:noOrigin,value:{}})).status,403);
  assert.equal((await h.request(route,{headers})).status,405);
 }
 assert.equal((await h.request(start,{method:'POST',headers,value:{name:'Drive',owner:'attacker'}})).status,400);
 assert.equal((await h.request(complete,{method:'POST',headers,value:{state:'x',error:'access_denied',redirect_uri:'https://attacker.example'}})).status,400);
 const pending=await read(await h.request(start,{method:'POST',headers,value:{name:'Audit Drive'}})),url=new URL(pending.authorizationUrl);
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.pathname,'/o/oauth2/v2/auth');assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.file');assert.equal(url.searchParams.get('redirect_uri'),h.origin+callback);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.match(url.searchParams.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);assert.match(url.searchParams.get('state'),/^[A-Za-z0-9_-]{43}$/);
 assert.equal(url.searchParams.has('client_secret'),false);assert.equal(url.searchParams.has('code_verifier'),false);
 const account=h.accounts.get(h.accounts.idFromName(owner.account.id)),rows=await account.rows();
 assert(rows.some(([key])=>key.startsWith('drive/oauth/')));assert(!JSON.stringify(rows).includes(url.searchParams.get('state')));assert(!JSON.stringify(rows).includes('dummy-secret'));
});

test('actual Worker Drive callback is an inert public redirect with bounded parameters and private headers',async t=>{
 const h=await createHarness();t.after(()=>h.close());
 const response=await h.mf.dispatchFetch(h.origin+callback+'?state=opaque-state&code=opaque-code&authuser=0',{redirect:'manual'});assert.equal(response.status,303);
 const location=response.headers.get('Location');assert.equal(location,'/integrations/google/complete#state=opaque-state&code=opaque-code');assert(!location.includes('?'));assert.match(response.headers.get('Cache-Control'),/no-store/);assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 for(const suffix of ['?state=one&state=two','?code='+('x'.repeat(4097)),'?state='+('x'.repeat(201)),'?error=bad%0Avalue'])assert.equal((await h.request(callback+suffix)).status,400);
 assert.equal((await h.request(callback,{method:'POST',value:{}})).status,405);
 const page=await h.request('/integrations/google/complete');assert.equal(page.status,200);assert.match(page.headers.get('Content-Type'),/text\/html/);
});

test('actual Worker Drive denial is session-bound, consumes matching state and performs no provider exchange',async t=>{
 const h=await createHarness({bindings:{GOOGLE_CLIENT_ID:'dummy-client',GOOGLE_CLIENT_SECRET:'dummy-secret'}});t.after(()=>h.close());const {headers,owner}=await signed(h);
 const pending=await read(await h.request(start,{method:'POST',headers,value:{name:'Denied Drive'}})),state=new URL(pending.authorizationUrl).searchParams.get('state');
 const login=await h.request('/api/auth/login/password',{method:'POST',headers:{Origin:h.origin},value:{handle:owner.account.handle,password:'isolated test account password',turnstileToken:'local-browser-test-token'}}),second=await read(login),otherHeaders={Origin:h.origin,Cookie:login.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':second.csrfToken};
 assert.equal((await read(await h.request(complete,{method:'POST',headers:otherHeaders,value:{state,error:'access_denied'}}),409)).error,'oauth_expired');
 assert.equal((await read(await h.request(complete,{method:'POST',headers,value:{state:'wrong',error:'access_denied'}}),403)).error,'oauth_state');
 assert.equal((await read(await h.request(complete,{method:'POST',headers,value:{state,error:'access_denied'}}),400)).error,'oauth_denied');
 assert.equal((await read(await h.request(complete,{method:'POST',headers,value:{state,error:'access_denied'}}),409)).error,'oauth_expired');
 const rows=await h.accounts.get(h.accounts.idFromName(owner.account.id)).rows();assert(!rows.some(([key])=>key.startsWith('drive/oauth/')||key.startsWith('drive/folder-pending/')||key.startsWith('resource/')));
});

test('actual Worker advertises unconfigured Drive disabled and rejects starting OAuth',async t=>{
 const h=await createHarness();t.after(()=>h.close());const config=await read(await h.request('/api/config'));assert.equal(config.providers.google.enabled,false);assert.equal(config.providers.google.configured,false);
 const {headers}=await signed(h);assert.equal((await read(await h.request(start,{method:'POST',headers,value:{name:'Drive'}}),503)).error,'integration_unconfigured');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {signOnboardingInvitation,signOnboardingIssuance,verifyOnboardingInvitation} from '../../packages/identity/onboarding.mjs';
import {encode} from '../../packages/identity/crypto.mjs';

test('actual Worker closed host reserves ordinary names and charges each once without system privileges',async t=>{
 const key=encode(new Uint8Array(32).fill(73));
 const h=await createHarness({bindings:{ONBOARDING_ENABLED:'true',ONBOARDING_KEY:key,ONBOARDING_NAMES:'["alice","bob"]',HOST_NAME_POLICY:JSON.stringify({version:1,reserved:['admin'],onboarding:['alice','bob']}),BADGE_DEFINITIONS:JSON.stringify([{id:'team',name:'Host team',description:'Assigned by this host',svg:'<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="currentColor"/></svg>'}]),SIGNUP_ENABLED:'false',SIGNUP_CONTACT_REQUIRED:'false'}});
 t.after(()=>h.close());
 const headers={Origin:h.origin},now=Date.now();
 const claims={version:1,purpose:'bindle-ordinary-account-onboarding',issuer:h.origin,nonce:crypto.randomUUID(),issuedAt:now,expiresAt:now+3600000,names:['alice','bob'].map(name=>({name,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID(),badgeIds:name==='alice'?['team']:[]}))};
 const onboardingToken=await signOnboardingInvitation(claims,key),verified=await verifyOnboardingInvitation(onboardingToken,key,h.origin);
 const issuanceProof=await signOnboardingIssuance(verified.digest,h.origin,key);
 assert.equal((await h.request('/api/auth/signup',{method:'POST',headers,value:{}})).status,503);
 assert.equal((await(await h.request('/api/config')).json()).signupEnabled,false);
 const post=(path,value,cookie)=>h.request('/api/auth/onboarding/'+path,{method:'POST',headers:{...headers,...cookie?{Cookie:cookie}:{}},value});
 const rejected=await post('issue',{onboardingToken,issuanceProof:onboardingToken});assert.equal(rejected.status,403);
 const issued=await post('issue',{onboardingToken,issuanceProof});assert.equal(issued.status,200,await issued.clone().text());
 const begin=await post('begin',{});assert.equal(begin.status,200);const cookie=begin.headers.get('Set-Cookie').split(';')[0];
 const inspected=await post('inspect',{onboardingToken},cookie);assert.equal(inspected.status,200);assert.deepEqual((await inspected.json()).names,[{name:'alice',status:'available'},{name:'bob',status:'available'}]);
 const pending=[];
 for(const item of claims.names){
  const input={onboardingToken,name:item.name,method:'password',password:'isolated private-host account password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'};
  const response=await post('claim',input,cookie);assert.equal(response.status,200,await response.clone().text());
  const value=await response.json();pending.push(value);assert.equal(value.account.id,item.owner);assert.equal(value.account.systemBadge,undefined);assert.deepEqual(value.account.badges,item.badgeIds);
  assert.equal((await h.directory.findByHandle(item.name)).id,item.owner);
  const account=await h.directory.get(item.owner);assert.equal(account.admission.kind,'operator');assert.equal(account.admission.plan,'free');assert.equal(account.systemIdentity,undefined);
  const replay=await post('claim',input,cookie);assert.equal(replay.status,409);assert.equal((await replay.json()).error,'onboarding_invitation_consumed');
 }
 const rows=new Map(await h.abuse.get(h.abuse.idFromName('signup:lifetime-admission')).rows());assert.equal(rows.get('lifetime'),2);assert.equal(rows.get('signup-capacity/v1').free,0);
 // Actual ordinary credential can resume interrupted setup; the invitation cannot.
 const resumed=await h.request('/api/auth/login/password',{method:'POST',headers:{...headers,Cookie:cookie},value:{handle:'alice',password:'isolated private-host account password',turnstileToken:'local-browser-test-token'}});
 assert.equal(resumed.status,200,await resumed.clone().text());const resumedSetup=await resumed.json();assert.equal(resumedSetup.resumed,true);const resumedCookie=resumed.headers.get('Set-Cookie').split(';')[0];
 const download=await h.request('/api/auth/recovery/download',{method:'POST',headers:{...headers,Cookie:resumedCookie},value:{pendingToken:resumedSetup.pendingToken}});assert.equal(download.status,200);const file=await download.json();
 const activation=await h.request('/api/auth/recovery/confirm',{method:'POST',headers:{...headers,Cookie:resumedCookie},value:{pendingToken:resumedSetup.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true}});assert.equal(activation.status,200,await activation.clone().text());assert(activation.headers.get('Set-Cookie').includes('bindle_session='));
 const login=await h.request('/api/auth/login/password',{method:'POST',headers,value:{handle:'alice',password:'isolated private-host account password',turnstileToken:'local-browser-test-token'}});assert.equal(login.status,200);const signedIn=await login.json();assert.equal(signedIn.account.id,claims.names[0].owner);assert(signedIn.account.aliases.includes('alice'));assert.equal(signedIn.account.systemBadge,undefined);assert.deepEqual(signedIn.account.badges,['team']);
 assert.equal((await h.request('/api/auth/signup',{method:'POST',headers,value:{}})).status,503);
});

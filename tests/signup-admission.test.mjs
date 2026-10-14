import test from 'node:test';import assert from 'node:assert/strict';
import {abuseWindows,enforceAbusePolicy} from '../packages/core/abuse-policy.mjs';
import {FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
test('admitted signup has independent restrictive IP, subnet, region, global and lifetime limits',()=>{
 const rows=abuseWindows({operation:'signup',phase:'admitted',ipHash:'ip',subnetHash:'subnet',regionHash:'region'});
 assert.deepEqual(rows.find(r=>r.key==='signup:ip-cooldown:ip'),{key:'signup:ip-cooldown:ip',windowMs:10800000,limit:1});
 assert.equal(rows.find(r=>r.key==='signup:region-hour:region').limit,5);assert.equal(rows.find(r=>r.key==='signup:global-hour').limit,10);
 assert.equal(rows.find(r=>r.key==='signup:global').limit,200);assert.equal(rows.find(r=>r.lifetime).limit,100000);
 const attempts=abuseWindows({operation:'signup',phase:'attempt',ipHash:'ip',subnetHash:'subnet'});assert.equal(attempts.some(r=>r.key==='signup:global'||r.lifetime),false);
});
test('persistent lifetime signup admission stops concurrent farming and survives controller recreation',async()=>{
 const metadata=new SqliteMetadata(':memory:');try{const guard=new FixedWindowGuard({metadata});const results=await Promise.all(Array.from({length:20},()=>guard.consume({lifetime:true,limit:3})));assert.equal(results.filter(Boolean).length,3);assert.equal(await new FixedWindowGuard({metadata}).consume({lifetime:true,limit:3}),false);await guard.alarm();assert.equal(await metadata.get('lifetime'),3);}finally{metadata.close();}
});
test('signup rejects when any regional or global window refuses and never bypasses refusal',async()=>{
 let called=[];const ok=await enforceAbusePolicy({consume:async row=>{called.push(row.key);return !row.key.startsWith('signup:region-hour');}},{operation:'signup',phase:'admitted',ipHash:'ip',subnetHash:'subnet',regionHash:'country'});assert.equal(ok,false);assert.equal(called.includes('signup:global'),false);
});

test('raising the signup ceiling preserves the existing durable counter and concurrent admissions stop at100000',async()=>{
 const metadata=new SqliteMetadata(':memory:');try{
  const row=abuseWindows({operation:'signup',phase:'admitted',ipHash:'ip',subnetHash:'net'}).find(row=>row.lifetime);
  assert.equal(row.key,'signup:lifetime-admission');
  await metadata.put('lifetime',1000);let guard=new FixedWindowGuard({metadata});
  assert.equal(await guard.consume({...row,limit:1000}),false);
  assert.equal(await guard.consume(row),true);assert.equal(await metadata.get('lifetime'),1001);
  await metadata.put('lifetime',99999);guard=new FixedWindowGuard({metadata});
  const results=await Promise.all(Array.from({length:20},()=>guard.consume(row)));
  assert.equal(results.filter(Boolean).length,1);assert.equal(await metadata.get('lifetime'),100000);
  await guard.alarm();assert.equal(await new FixedWindowGuard({metadata}).consume(row),false);
  assert.equal(await metadata.get('lifetime'),100000);
 }finally{metadata.close();}
});

test('signup stock config rejects invalid limits and lower limits never reset existing admissions',async()=>{
 for(const value of [0,-1,1.5,'', 'not-a-number',true,false,null,[],[100000],{},'1e5','0x10',' 100000 ',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>abuseWindows({operation:'signup',phase:'admitted',signupLimits:{SIGNUP_MAX_ADMISSIONS:value}}),/Invalid signup limit/);
 const metadata=new SqliteMetadata(':memory:');try{
  await metadata.put('lifetime',25);const row=abuseWindows({operation:'signup',phase:'admitted',signupLimits:{SIGNUP_MAX_ADMISSIONS:'20'}}).find(row=>row.lifetime);
  assert.equal(await new FixedWindowGuard({metadata}).consume(row),false);assert.equal(await metadata.get('lifetime'),25);
  for(const corrupt of [-1,1.5,'25',null]){await metadata.put('lifetime',corrupt);assert.equal(await new FixedWindowGuard({metadata}).consume({...row,limit:100000}),false);assert.deepEqual(await metadata.get('lifetime'),corrupt);}
 }finally{metadata.close();}
});

test('checked-in Worker deployments use100000 overall and10000 free-origin admission ceilings',async()=>{
 const {readFile}=await import('node:fs/promises');for(const name of ['wrangler.jsonc','wrangler.local.jsonc']){const contents=await readFile(new URL('../'+name,import.meta.url),'utf8');assert.match(contents,/"SIGNUP_MAX_ADMISSIONS"\s*:\s*"100000"/);assert.match(contents,/"SIGNUP_FREE_MAX_ADMISSIONS"\s*:\s*"10000"/);}
});

test('Node environment cap reaches actual signup and explicit higher config preserves prior consumed stock across restart',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createNodeServer}=await import('../apps/node/server.mjs');
 const directory=await mkdtemp(join(tmpdir(),'bindle-signup-cap-')),prior=process.env.SIGNUP_MAX_ADMISSIONS;let app;
 const signup=ip=>app.fetch(new Request('http://localhost:8788/api/auth/signup',{method:'POST',headers:{Origin:'http://localhost:8788','Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({method:'password',password:'isolated admission-cap test password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'})}));
 try{
  process.env.SIGNUP_MAX_ADMISSIONS='1';app=await createNodeServer({directory});
  assert.equal((await signup('192.0.2.1')).status,200);assert.equal((await signup('192.0.2.2')).status,503);
  await app.close();app=await createNodeServer({directory,config:{SIGNUP_MAX_ADMISSIONS:'2'}});
  assert.equal((await signup('192.0.2.3')).status,200);assert.equal((await signup('192.0.2.4')).status,503);
 }finally{await app?.close();if(prior===undefined)delete process.env.SIGNUP_MAX_ADMISSIONS;else process.env.SIGNUP_MAX_ADMISSIONS=prior;await rm(directory,{recursive:true,force:true});}
});

test('Node free cap refuses stale forms while paid pending uses only global stock and cannot authenticate',async()=>{const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createNodeServer}=await import('../apps/node/server.mjs');const directory=await mkdtemp(join(tmpdir(),'bindle-signup-lanes-'));let app;const config={SIGNUP_MAX_ADMISSIONS:'2',SIGNUP_FREE_MAX_ADMISSIONS:'1',PAID_SIGNUP_ENABLED:'true',BILLING_ENABLED:'true',POLAR_SERVER:'sandbox',POLAR_ACCESS_TOKEN:'offline-test',POLAR_WEBHOOK_SECRET:'offline-test',POLAR_PRODUCT_ID_PAID:'paid-product',POLAR_PRODUCT_ID_PLUS:'plus-product',POLAR_PRODUCT_ID_ULTRA:'ultra-product'};try{app=await createNodeServer({directory,config});const signup=(ip,signupPlan)=>app.fetch(new Request('http://localhost:8788/api/auth/signup',{method:'POST',headers:{Origin:'http://localhost:8788','Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({signupPlan,method:'password',password:'isolated paid signup test password',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'})}));assert.equal((await signup('192.0.2.1','free')).status,200);const denied=await signup('192.0.2.2','free');assert.equal(denied.status,503);assert.equal((await denied.json()).capacity,'free');assert.equal(denied.headers.get('Retry-After'),null);const paid=await signup('192.0.2.3','paid');assert.equal(paid.status,200);const value=await paid.json();assert.equal(value.paymentRequired,true);assert.equal(value.account.status,'pending');assert(!paid.headers.get('Set-Cookie')?.includes('bindle_session='));assert.equal((await app.resources.repository.get(value.account.id)).admission.kind,'paid');assert.deepEqual(await app.resources.abuse.signupStatus('signup:lifetime-admission',{limit:2,freeLimit:1}),{globalAvailable:false,freeAvailable:false});const full=await signup('192.0.2.4','paid');assert.equal(full.status,503);assert.equal((await full.json()).capacity,'global');}finally{await app?.close();await rm(directory,{recursive:true,force:true});}});

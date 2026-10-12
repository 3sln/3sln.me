import test from 'node:test';import assert from 'node:assert/strict';
import {abuseWindows,enforceAbusePolicy} from '../packages/core/abuse-policy.mjs';
import {FixedWindowGuard} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
test('admitted signup has independent restrictive IP, subnet, region, global and lifetime limits',()=>{
 const rows=abuseWindows({operation:'signup',phase:'admitted',ipHash:'ip',subnetHash:'subnet',regionHash:'region'});
 assert.deepEqual(rows.find(r=>r.key==='signup:ip-cooldown:ip'),{key:'signup:ip-cooldown:ip',windowMs:10800000,limit:1});
 assert.equal(rows.find(r=>r.key==='signup:region-hour:region').limit,5);assert.equal(rows.find(r=>r.key==='signup:global-hour').limit,10);
 assert.equal(rows.find(r=>r.key==='signup:global').limit,200);assert.equal(rows.find(r=>r.lifetime).limit,1000);
 const attempts=abuseWindows({operation:'signup',phase:'attempt',ipHash:'ip',subnetHash:'subnet'});assert.equal(attempts.some(r=>r.key==='signup:global'||r.lifetime),false);
});
test('persistent lifetime signup admission stops concurrent farming and survives controller recreation',async()=>{
 const metadata=new SqliteMetadata(':memory:');try{const guard=new FixedWindowGuard({metadata});const results=await Promise.all(Array.from({length:20},()=>guard.consume({lifetime:true,limit:3})));assert.equal(results.filter(Boolean).length,3);assert.equal(await new FixedWindowGuard({metadata}).consume({lifetime:true,limit:3}),false);await guard.alarm();assert.equal(await metadata.get('lifetime'),3);}finally{metadata.close();}
});
test('signup rejects when any regional or global window refuses and never bypasses refusal',async()=>{
 let called=[];const ok=await enforceAbusePolicy({consume:async row=>{called.push(row.key);return !row.key.startsWith('signup:region-hour');}},{operation:'signup',phase:'admitted',ipHash:'ip',subnetHash:'subnet',regionHash:'country'});assert.equal(ok,false);assert.equal(called.includes('signup:global'),false);
});

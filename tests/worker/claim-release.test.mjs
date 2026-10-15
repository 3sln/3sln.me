import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {identityShardName,ONBOARDING_RELEASE_GRACE_MS} from '../../packages/runtime/identity-shards.mjs';

test('actual Worker identity alarm releases only expired unredeemed reservations',async t=>{
 const h=await createHarness({bindings:{HOST_NAME_POLICY:JSON.stringify({version:1,reserved:['admin'],onboarding:['alice']})}});
 t.after(()=>h.close());
 const identities=await h.mf.getDurableObjectNamespace('IDENTITIES'),bucket=async name=>identities.get(identities.idFromName(await identityShardName('namespace',name)));
 const digest='a'.repeat(64),binding='b'.repeat(43),past=Date.now()-ONBOARDING_RELEASE_GRACE_MS-1000,future=Date.now()+3600000;
 const reserve=async(name,expiresAt)=>(await bucket(name)).shardOnboardingReserve({name,owner:crypto.randomUUID(),assignmentId:crypto.randomUUID()},{nonce:crypto.randomUUID(),expiresAt},digest);
 const later=future+3600000,pending=await reserve('pending',later);assert.equal(pending.phase,'preissued');
 assert.equal(await (await bucket('pending')).alarmAt(),later+ONBOARDING_RELEASE_GRACE_MS);
 // Redeemed-in-progress and statically configured names survive even a sweep long after expiry.
 for(const name of ['started','alice'])await reserve(name,future);
 assert.equal((await (await bucket('started')).shardOnboardingClaim('started',digest,binding)).phase,'claiming');
 for(const name of ['started','alice'])assert.deepEqual((await (await bucket(name)).shardOnboardingSweep({now:future+ONBOARDING_RELEASE_GRACE_MS})).released,[]);
 // An already expired reservation arms an immediate alarm; firing it again is idempotent.
 await reserve('expired',past);await (await bucket('expired')).fireAlarm();await (await bucket('pending')).fireAlarm();
 assert.equal(await h.directory.onboardingLookup('expired'),null);
 assert.equal((await h.directory.onboardingLookup('started')).onboarding.phase,'claiming');
 assert.equal((await h.directory.onboardingLookup('alice')).onboarding.phase,'preissued');
 assert.equal((await h.directory.onboardingLookup('pending')).onboarding.phase,'preissued');
 assert.equal(await (await bucket('pending')).alarmAt(),later+ONBOARDING_RELEASE_GRACE_MS);
 // A redemption arriving after release finds nothing to bind.
 assert.equal(await (await bucket('expired')).shardOnboardingClaim('expired',digest,binding),null);
});

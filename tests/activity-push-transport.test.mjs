// ACT-2 Web Push options: activity notices set Urgency, a collapse Topic and TTL; the legacy request is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import webpush from 'web-push';
import {createPushTransport} from '../packages/messaging/web-push.mjs';

function fixture(){const vapid=webpush.generateVAPIDKeys(),user=createECDH('prime256v1');user.generateKeys();const auth=randomBytes(16);return {config:{PUSH_ENABLED:'true',APP_ORIGIN:'https://3sln.example',VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey},subscription:{endpoint:'https://fcm.googleapis.com/wp/opaque-device-endpoint',keys:{p256dh:user.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}}};}

test('activity options set Urgency, Topic and TTL; omitted options keep the existing request exactly', async()=>{
 const f=fixture(),requests=[];const push=createPushTransport(f.config,{fetcher:async(url,init)=>{requests.push(init.headers);return new Response(null,{status:201});}});
 await push.send(f.subscription,{type:'bindle-message'});
 assert.equal(requests[0].Urgency,'normal');assert.equal(String(requests[0].TTL),'600');assert.equal(requests[0].Topic,undefined);
 await push.send(f.subscription,{type:'bindle-activity'},{urgency:'high',topic:'A'.repeat(32),ttl:3600});
 assert.equal(requests[1].Urgency,'high');assert.equal(requests[1].Topic,'A'.repeat(32));assert.equal(String(requests[1].TTL),'3600');
 for(const options of [{urgency:'emergency'},{topic:'x'.repeat(33)},{topic:'has space'},{topic:''},{ttl:-1},{ttl:86401},{ttl:1.5}])
  await assert.rejects(push.send(f.subscription,{type:'bindle-activity'},options),error=>error.code==='invalid_push_options');
 assert.equal(requests.length,2,'invalid options never reach the network');
});

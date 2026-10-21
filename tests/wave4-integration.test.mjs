import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createNodeIntegrationEgress} from '../packages/federation/node-integration-egress.mjs';
import {integrationPorts,pendingPreferencesSnapshot} from '../packages/runtime/integration-ports.mjs';
import {eventDoorbellGrant} from '../packages/federation/event-readers.mjs';
import {EVENT_BUS_CONTRACT as CONTRACT} from '../packages/events/limits.mjs';
const issuer='https://provider.example',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bus='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',clientId='https://consumer.example/client.json';
test('Wave 4 ports stay off and X8 snapshots stay unavailable; minting binds the provider client',async()=>{
 const calls=[],deps={signer:{sign(){}},eventEgress:{send(){}},egress:{send(){}},mint:async c=>{calls.push(c);return {token:'signed'};},describe:async()=>({})};
 assert.deepEqual(integrationPorts({},deps),{});const partial=integrationPorts({INTEGRATIONS_ENABLED:'true'},deps);assert.equal(partial.BROKERING_MINT,undefined);assert.equal(partial.MESSAGING_DESCRIBE,undefined);
 const ports=integrationPorts({APP_ORIGIN:issuer,INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',BINDLEBOX_ENABLED:'true'},deps);assert.equal(typeof ports.MESSAGING_DESCRIBE,'function');await ports.BROKERING_MINT({clientId:'attacker',purpose:'discover'});assert.equal(calls[0].clientId,issuer);await assert.rejects(pendingPreferencesSnapshot(),{code:'snapshot_unavailable'});
});
test('Node discovery pins DNS through the TLS connection, bounds replies, refuses mixed public/private DNS and redirects',async()=>{
 let captured,lookups=0,status=200,responseBody='{"v":1}',length;const request=(options,callback)=>{captured=options;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':'application/json',...length?{'content-length':length}:{}};res.destroy=()=>{};callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from(responseBody));res.emit('end');});});return req;};
 const transport=createNodeIntegrationEgress({issuer,lookup:async()=>{lookups++;return [{address:'93.184.216.34',family:4}];},request});const input={url:'https://integration.example/bindle/resources',headers:{Authorization:'Bearer signed'},body:'{}',maxBytes:100};
 assert.equal((await transport.send(input)).status,200);assert.equal(lookups,1);assert.equal(captured.method,'POST');assert.equal(captured.servername,'integration.example');assert.equal(captured.rejectUnauthorized,true);assert.equal(captured.headers.Authorization,'Bearer signed');captured.lookup('integration.example',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});
 status=302;assert.equal((await transport.send(input)).status,302);status=200;responseBody='x'.repeat(101);await assert.rejects(transport.send(input),{code:'egress_refused'});responseBody='{}';length='101';await assert.rejects(transport.send(input),{code:'egress_refused'});
 const unsafe=createNodeIntegrationEgress({issuer,lookup:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],request:()=>{throw new Error('must not connect');}});await assert.rejects(unsafe.send(input),{code:'egress_refused'});await assert.rejects(transport.send({...input,url:issuer+'/resources'}),{code:'egress_refused'});
});
test('Doorbell live grant requires current identity, connection, read epoch, contract methods and pinned assignment',async()=>{
 const subject=`${issuer}/entities/${owner}`,resource=`${subject}/buses/${bus}`,fragment='https://schema.example/feed/v1',map=new Map(),key=(kind,id)=>`federation/${kind}/${id}`;
 const grant={id:'g',active:true,subject,clientId,epoch:'identity',readSince:'read-1',connection:{id:'c',generation:1},fragment,digest:'d',resources:{feed:[resource]},resourceGenerations:{[resource]:'v1'},methods:{feed:{[CONTRACT]:['read','subscribe']}}};
 map.set(key('grant','g'),grant);map.set(key('resource',resource),{owner:subject,generation:'v1',contracts:{[CONTRACT]:['read','subscribe']}});map.set(key('schema',fragment),{digest:'d',schema:{fields:{feed:{type:'resource'}}}});map.set(key('preferences',`${subject}|${fragment}`),{digest:'d',values:{feed:resource}});
 const s={issuer,routingKey:owner,incrementalIdentity:async()=>({epoch:'identity'}),active:async()=>true,ensureClients:async()=>{},clients:new Map([[clientId,{}]]),connections:{check:async c=>c.generation===1},store:{transaction:fn=>fn({get:async k=>map.get(k),list:async prefix=>[...map].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))})}};
 const input={owner,bus,clientId,connection:'c',generation:1,epoch:'grant:read-1'};assert.equal(await eventDoorbellGrant(s,input),true);grant.methods.feed[CONTRACT]=['read'];assert.equal(await eventDoorbellGrant(s,input),false);grant.methods.feed[CONTRACT].push('subscribe');grant.connection.generation=2;assert.equal(await eventDoorbellGrant(s,input),false);grant.connection.generation=1;assert.equal(await eventDoorbellGrant(s,{...input,epoch:'grant:old'}),false);map.get(key('preferences',`${subject}|${fragment}`)).values.feed='https://other.example/bus';assert.equal(await eventDoorbellGrant(s,input),false);
});

test('Node production composition mounts persistent signing, discovery and describe ports and the real account alarm hook',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{nodeResources}=await import('../apps/node/resources.mjs'),{verifyAccessToken}=await import('../packages/federation/signing.mjs');
 const directory=await mkdtemp(join(tmpdir(),'bindle-wave4-')),resources=await nodeResources({directory,config:{APP_ORIGIN:issuer,KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',BINDLEBOX_ENABLED:'true'}});t.after(async()=>{resources.close();await rm(directory,{recursive:true,force:true});});
 const c=resources.accounts.get(owner),ports=c.config.INTEGRATION_EVENT_PORTS;assert.equal(typeof ports.egress.send,'function');assert.equal(typeof c.config.INTEGRATION_EGRESS.send,'function');assert.equal(typeof c.config.MESSAGING_DESCRIBE,'function');assert.equal(ports.snapshot.available,false);
 const audience='https://integration.example/bindle/resources',{token}=await c.config.BROKERING_MINT({subject:`${issuer}/entities/${owner}`,audience,purpose:'discover',connection:'connection-1',generation:1,lifetime:60});const {claims}=await verifyAccessToken(token,{keys:await resources.brokering.jwks(),issuer,audience,purposes:['discover']});assert.equal(claims.client_id,issuer);
 await c.touch(owner);let calls=0;const alarm=c.integrationEventsAlarm.bind(c);c.integrationEventsAlarm=async id=>{calls++;return alarm(id);};await c.alarm();assert.equal(calls,1);
 await assert.rejects(c.config.MESSAGING_DESCRIBE({owner,slot:'https://slots.example/missing/v1'}),{code:'recipient_unavailable'});
});

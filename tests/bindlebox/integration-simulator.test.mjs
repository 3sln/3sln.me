import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createMailboxSimulator} from '../../packages/bindlebox-engine/simulator.mjs';
import {MAILBOX_OPERATIONS} from '../../packages/bindlebox-engine/operations.mjs';
import {CONTACT_OPERATIONS} from '../../packages/bindlebox-engine/domains/contacts.mjs';
import {RECEIVE_OPERATIONS} from '../../packages/bindlebox-engine/domains/receive.mjs';
import {INTAKE_OPERATIONS} from '../../packages/bindlebox-engine/domains/intake.mjs';
import {DELEGATION_OPERATIONS} from '../../packages/bindlebox-engine/domains/delegation.mjs';
import {SEND_OPERATIONS} from '../../packages/bindlebox-engine/domains/send.mjs';
import {OUTBOX_OPERATIONS} from '../../packages/bindlebox-engine/domains/outbox.mjs';
import {EVENT_OPERATIONS} from '../../packages/bindlebox-engine/domains/events.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';

test('BB-B2/B3 registry includes every contact, receive, intake, delegation, send and progress operation',()=>{
 for(const Operation of [...CONTACT_OPERATIONS,...RECEIVE_OPERATIONS,...INTAKE_OPERATIONS,...DELEGATION_OPERATIONS,...SEND_OPERATIONS,...OUTBOX_OPERATIONS,...EVENT_OPERATIONS])assert.equal(MAILBOX_OPERATIONS[Operation.operation],Operation);
});
test('two simulated engines: send → receive → committed custody receipt → delivered status',async t=>{
 const sim=await createMailboxSimulator({count:2,seed:7});t.after(()=>sim.dispose());const alice=sim.peers.get('alice'),bob=sim.peers.get('bob'),input=await sim.prepare('alice','bob',{text:'Integration proof'});
 const submitted=await alice.run('send.submit',{input});assert.equal(submitted.pending,1);assert.equal((await bob.run('receive.items')).items.length,0);
 assert.equal((await alice.run('outbox.drain')).attempted,1);assert.deepEqual(sim.trace,[{from:'alice',to:'bob'}]);
 const received=(await bob.run('receive.items')).items;assert.equal(received.length,1);assert.equal(received[0].author.verified,true);assert.equal(received[0].author.principal.subject,alice.owner);
 const task=[...(await alice.store.list({prefix:'bb:send:task/'})).values()][0];assert.equal(task.state,'delivered');assert.ok(task.receipt);
 await B.verifyReceipt(task.receipt,{obligation:{principal:bob.principal,ingress:bob.ingress,operationId:input.operationId,payloadDigest:await B.payloadDigest(input.recipients[0].envelope),bodyDigest:await B.sha256(crypto,input.body),kind:'one-off'},resolveKey:sim.directory.resolveKey,status:sim.directory.status,now:sim.clock.now()});
 const view=await alice.run('outbox.get',{id:input.operationId});assert.deepEqual([view.delivered,view.pending,view.failed],[1,0,0]);
 assert.equal((await alice.run('outbox.drain')).attempted,0);assert.equal((await bob.run('receive.items')).items.length,1);
 sim.clock.advance(250);const page=await alice.run('send.events');assert.ok(page.events.some(e=>e.data.delivered===1));
});
test('BindleBox CLI composes the same two-peer send/receive simulator and named inputs',()=>{
 const steps=[{as:'alice',prepare:{to:'bob',text:'CLI integration'},save:'draft'},{as:'alice',op:'send.submit',input:{$:'draft'},expect:{pending:1}},{as:'alice',op:'outbox.drain',expect:{attempted:1,pending:0}},{as:'bob',op:'receive.items'},{as:'alice',op:'outbox.get',id:{$:'draft.operationId'},expect:{delivered:1,pending:0}}];
 const run=spawnSync(process.execPath,['scripts/bindlebox.mjs','--peers','2','-'],{input:steps.map(JSON.stringify).join('\n'),encoding:'utf8'});assert.equal(run.status,0,run.stderr+run.stdout);const lines=run.stdout.trim().split('\n').map(JSON.parse);assert.equal(lines[3].result.items.length,1);assert.ok(lines.every(line=>line.ok));
});

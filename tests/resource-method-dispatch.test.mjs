import test from 'node:test';
import assert from 'node:assert/strict';
import {methods,RESOURCE_METHOD_HANDLERS} from '../packages/runtime/account/storage.mjs';
import {APP_NOTIFICATIONS} from '../packages/federation/app-notifications.mjs';

const origin='https://provider.example',owner='00000000-0000-4000-8000-000000000001',subject=`${origin}/entities/${owner}`;
test('resource-method registry dispatch preserves the contract handler and owner boundary',async()=>{
 const stopped=new Error('handler reached'),seen=[],controller={config:{APP_ORIGIN:origin},warm:async value=>{seen.push(value);throw stopped;}},tx=crypto.randomUUID(),context={subject,contract:APP_NOTIFICATIONS,method:'createOwn',tx,args:{transactionId:tx,createdAt:Date.now(),subject:'Reminder',body:'Hello'}};
 assert(Object.isFrozen(RESOURCE_METHOD_HANDLERS));await assert.rejects(methods.federationRPC.call(controller,{...context,subject:'https://other.example/entities/'+owner}),{code:'forbidden'});assert.deepEqual(seen,[]);
 await assert.rejects(methods.federationRPC.call(controller,context),error=>error===stopped);assert.deepEqual(seen,[owner]);
});
test('unregistered and inherited contract names retain the storage fallback',async()=>{
 const controller={config:{APP_ORIGIN:origin}};
 for(const contract of ['https://contracts.example/unknown/v1','toString','__proto__'])await assert.rejects(methods.federationRPC.call(controller,{subject,contract,method:'list'}),{code:'unsupported_method'});
});

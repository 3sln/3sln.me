import test from 'node:test';import assert from 'node:assert/strict';
import {Engine,Provider} from '../../apps/web/src/shared/stack.mjs';
import StateProvider from '../../apps/web/src/providers/browser-state.mjs';
import {LoadIncoming} from '../../apps/web/src/bl/incoming.mjs';
import {createTestEngine,OWNER,ownerActor} from '../helpers/app-engine.mjs';
import {ActivityFeed,ActivityItem,CreateActivity,MarkActivity,ArchiveActivity,ReplaceActivity,RetractActivity} from '../../packages/app/domains/activity.mjs';
import {ACTIVITY_PUSH_OWNER_OPERATIONS as Push} from '../../packages/messaging/notifications.mjs';
import {canonical} from '../../packages/core/primitives.mjs';
import {base64url} from '../../packages/core/records.mjs';

test('ACT-3 browser Actions drive actual ACT-1 and ACT-2 engine contracts',async()=>{
 const backend=await createTestEngine(),actor=ownerActor(OWNER),connection='550e8400-e29b-41d4-a716-446655440002',appActor={kind:'app',owner:OWNER,issuer:'https://issuer.example',app:{clientId:'https://app.example/client',origin:'https://app.example',name:'App'},connection:{id:connection,generation:1,admissionGeneration:2}};
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),keys={kid:'test',sign:async payload=>base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(canonical(payload)))))};
 const input=extra=>({operationId:crypto.randomUUID(),createdAt:backend.clock.now(),...extra});
 let engine;try{
  await backend.metadata.put('owner',OWNER);await backend.metadata.put('resource/'+connection,{id:connection,owner:OWNER,kind:'app-connection',provider:'app',transport:'bindle',status:'active',clientId:appActor.app.clientId,appOrigin:appActor.app.origin,generation:1,notifications:{enabled:true,generation:2}});
  const created=await backend.perform(new CreateActivity({actor:appActor,input:input({subject:'Receipt',body:'Private account text',tags:['receipt']}),keys})),id=created.item;
  const api={get:async path=>{const u=new URL(path,'https://issuer.example');if(u.pathname==='/api/activity')return backend.read(new ActivityFeed({actor,input:{limit:Number(u.searchParams.get('limit')),archived:u.searchParams.get('archived')==='true'}}));if(u.pathname.startsWith('/api/activity/'))return backend.read(new ActivityItem({actor,id:u.pathname.split('/').at(-1)}));if(path==='/api/notifications/activity')return backend.read(new Push.settings({actor}));if(path==='/api/apps')return {apps:[{id:connection,name:'App',transport:'bindle',status:'active',generation:1}]};throw Error(path);},request:async(path,body,method)=>{if(path.startsWith('/api/activity/'))return backend.perform(new (Object.hasOwn(body,'archived')?ArchiveActivity:MarkActivity)({actor,id:path.split('/').at(-1),input:body}));if(path==='/api/notifications/activity')return backend.perform(new Push.configure({actor,input:body}));if(path.endsWith('/apps/'+connection))return backend.perform(new Push.app({actor,id:connection,input:body}));throw Error(path);}};
  engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton({id:()=>crypto.randomUUID()})}});
  const write=patch=>engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,patch))),read=()=>engine.container.use(['state'],({state})=>state.snapshot()),act=(action,extra={})=>engine.dispatch(new LoadIncoming({...action?{activityAction:action}:{},...extra})).next('complete');await write({session:{account:{id:OWNER},sessionContext:'session-context'},data:{views:[]},config:{activityV2Enabled:true}});
  await act();assert.equal((await read()).incoming.items[0].tags[0].namespace,'app');await act('open',{id});assert.equal((await read()).incoming.detail.read,true);
  await backend.perform(new ReplaceActivity({actor:appActor,input:input({item:id,expectedRevision:1,subject:'Updated receipt',body:'New text',tags:['receipt']}),keys}));await act('reload');assert.equal((await read()).incoming.items[0].revision,2);assert.equal((await read()).incoming.items[0].read,true,'Replacement preserves read state');
  await act('archive',{id});assert.equal((await read()).incoming.items.length,0);await act('filter',{field:'archived',value:'true'});assert.equal((await read()).incoming.items.length,1);
  await act('push-load');await act('push-app',{id:connection,values:{mode:'selected',tags:'receipt',route:'digest'}});assert.equal((await read()).incoming.push.apps[0].mode,'selected');await act('push-save',{values:{startHour:'22',endHour:'8',timeZone:'America/Merida',utcOffsetMinutes:'-360',cadence:'daily',hour:'8'}});assert.equal((await read()).incoming.push.policy.quiet.timeZone,'America/Merida');
  await act('rule-save',{values:{app:connection,route:'digest',minPriority:'normal',priority:'',tags:'receipt',excludeTags:''}});assert.equal((await read()).error,'');await act('pause');assert.equal((await read()).incoming.push.policy.paused,true,'Nullable priorities round-trip through configure');
  await backend.perform(new RetractActivity({actor:appActor,input:input({item:id,expectedRevision:2}),keys}));await act('reload');await act('open',{id});assert.equal((await read()).incoming.detail.state,'retracted');assert.equal((await read()).incoming.detail.content.inert,true);
 }finally{await engine?.dispose();await backend.dispose();}
});

import {activityDocument} from '../../apps/web/src/bl/activity-content.mjs';
import {renderMessage} from '../../packages/content/render.mjs';
test('browser inert activity adapter preserves the server rendering policy',()=>{for(const body of ['Plain & <text> \"quoted\"', '<p style=\"color:red\">Body</p><form action=\"https://remote.example\"><input></form><script>alert(1)</script><img src=\"https://remote.example/pixel\">','<svg><foreignObject><p>Test</p></foreignObject></svg>','<table><tr><td>X</td></tr></table><!-- comment -->'])for(const mimeType of ['text/plain','text/html'])assert.deepEqual(activityDocument({mimeType,body}),renderMessage({mimeType,bytes:new TextEncoder().encode(body)}));});

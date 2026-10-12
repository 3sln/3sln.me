import test from 'node:test';
import assert from 'node:assert/strict';
import {beamRoutes} from '../packages/beaming/http.mjs';
import {BeamContacts} from '../packages/beaming/contacts.mjs';
import {key} from '../packages/messaging/store.mjs';
import {CONTACT_PROFILE_MIME,selectContactRepresentation} from '../packages/beaming/profile.mjs';

const sender='11111111-1111-4111-8111-111111111111';
const recipient='22222222-2222-4222-8222-222222222222';
const offerId='33333333-3333-4333-8333-333333333333';
const grantId='44444444-4444-4444-8444-444444444444';
function fixture({viewer=sender}={}){
 const record={id:offerId,sender,recipient,senderDevice:'sender-device',recipientDevice:null,allowedDevices:['recipient-device'],permission:{kind:'contact',id:grantId}};
 const accounts=new Map([[sender,{status:'active',sessions:[{id:'sender-device',expiresAt:Date.now()+60000}]}],[recipient,{status:'active',handle:'receiver',sessions:[{id:'recipient-device',expiresAt:Date.now()+60000}]}]]);
 const calls=[];
 const peer={beamContactInfo:async()=>({beamEnabled:true,profile:null}),beamPermission:async()=>({kind:'contact',id:grantId}),beamDisclosed:async()=>null,beamRaw:async()=>record,beamAction:async(...args)=>{calls.push(args);return {id:offerId,role:args[2].account===sender?'sender':'recipient'};}};
 const object={beamMailbox:async()=>({offers:[],pollAfterMs:5000}),beamOutbox:async()=>[{sender,id:offerId}],beamDirectory:async()=>[{peer:recipient,grantId}]};
 const env={APP_ORIGIN:'https://portal.example',IDENTITY_REPOSITORY:{get:async id=>accounts.get(id)}};
 const fetch=async(path,method='GET',value)=>beamRoutes({path,url:new URL(path,env.APP_ORIGIN),request:new Request(new URL(path,env.APP_ORIGIN),{method}),env,owner:{account:{id:viewer},devices:[{id:viewer===sender?'sender-device':'recipient-device',current:true}]},object,accountHandle:()=>peer,body:async()=>value,json:value=>value});
 return {record,accounts,peer,object,calls,fetch};
}

test('sender mailbox includes its outgoing offer so acceptance can start negotiation',async()=>{
 const f=fixture();const result=await f.fetch('/api/beams/mailbox');assert.equal(result.offers.length,1);assert.equal(result.offers[0].role,'sender');
});

test('contact directory does not disclose recipient session inventory',async()=>{
 const f=fixture();const result=await f.fetch('/api/contacts/directory');assert.equal(result[0].handle,'receiver');assert.equal(Object.hasOwn(result[0],'devices'),false);assert.equal(JSON.stringify(result).includes('recipient-device'),false);
});

test('a different live contact grant cannot revive an offer whose original grant was revoked',async()=>{
 const f=fixture();f.peer.beamPermission=async()=>({kind:'contact',id:'55555555-5555-4555-8555-555555555555'});
 await assert.rejects(f.fetch(`/api/beams/${sender}/${offerId}`),{code:'beam_contact_revoked'});assert.equal(f.calls.length,0);
});

test('offer authorization rejects a revoked sending device before dispatching signaling',async()=>{
 const f=fixture();f.accounts.get(sender).sessions=[];
 await assert.rejects(f.fetch(`/api/beams/${sender}/${offerId}/signal`,'POST',{seq:1}),{code:'beam_device_revoked'});assert.equal(f.calls.length,0);
});

test('profile disclosure uses only the exact redeemed link field allowlist and master consent',async()=>{
 const secondGrant='55555555-5555-4555-8555-555555555555',expiresAt=Date.now()+60000;
 const rows=new Map([
  ['beam/profile',{owner:recipient,displayName:'Chosen name',bio:'Private biography',avatar:'https://images.example/avatar.png',discloseToContacts:true}],
  ['beam/redeemed/'+grantId,{owner:recipient,peer:sender,grantId}],
  ['beam/redeemed/'+secondGrant,{owner:recipient,peer:sender,grantId:secondGrant}],
  [key('contact-grant',grantId),{owner:recipient,active:true,claims:{exp:expiresAt/1000}}],
  [key('contact-grant',secondGrant),{owner:recipient,active:true,claims:{exp:expiresAt/1000}}],
  ['beam/grant/'+grantId,{beamEnabled:true,profileFields:[]}],
  ['beam/grant/'+secondGrant,{beamEnabled:true,profileFields:['displayName']}]
 ]);
 const metadata={get:async id=>structuredClone(rows.get(id)),list:async({prefix,limit=1000})=>new Map([...rows].filter(([id])=>id.startsWith(prefix)).slice(0,limit))};
 const contacts=new BeamContacts({metadata,endpoints:{}});
 assert.equal(await contacts.disclosed(recipient,sender),null);
 assert.equal(await contacts.disclosed(recipient,sender,{grantId}),null);
 const disclosed=await contacts.disclosed(recipient,sender,{grantId:secondGrant});
 assert.deepEqual(disclosed,{displayName:'Chosen name'});
 rows.get('beam/grant/'+secondGrant).beamEnabled=false;
 assert.deepEqual(await contacts.contactInfo(recipient,sender,{grantId:secondGrant}),{beamEnabled:false,profile:{displayName:'Chosen name'}});
 await assert.rejects(contacts.permission(recipient,sender,{grantId:secondGrant}),{code:'beam_contact_required'});
 rows.get('beam/profile').discloseToContacts=false;
 assert.equal(await contacts.disclosed(recipient,sender,{grantId:secondGrant}),null);
 rows.get('beam/profile').discloseToContacts=true;
 rows.get(key('contact-grant',secondGrant)).active=false;
 await assert.rejects(contacts.disclosed(recipient,sender,{grantId:secondGrant}),{code:'beam_contact_required'});
});

test('public contact representation honors media preferences and exact exclusions',()=>{
 const token='application/vnd.bindle.contact-token+jwt';
 assert.equal(selectContactRepresentation(), 'text/html');
 assert.equal(selectContactRepresentation('*/*'), 'text/html');
 assert.equal(selectContactRepresentation(CONTACT_PROFILE_MIME), CONTACT_PROFILE_MIME);
 assert.equal(selectContactRepresentation(CONTACT_PROFILE_MIME.toUpperCase()), CONTACT_PROFILE_MIME);
 assert.equal(selectContactRepresentation(`${CONTACT_PROFILE_MIME};q=0.2, text/html;q=1`),'text/html');
 assert.equal(selectContactRepresentation(`${CONTACT_PROFILE_MIME};q=1, text/html;q=0.2`),CONTACT_PROFILE_MIME);
 assert.equal(selectContactRepresentation(`${CONTACT_PROFILE_MIME};q=0, */*;q=1`),'text/html');
 assert.equal(selectContactRepresentation(`text/html;q=0, ${CONTACT_PROFILE_MIME};q=0, application/json;q=0, ${token};q=0, */*;q=1`),null);
 assert.equal(selectContactRepresentation(`${CONTACT_PROFILE_MIME};q=1.5`),null);
 assert.equal(selectContactRepresentation('image/png'),null);
 assert.equal(selectContactRepresentation(token),token);
});

test('public profile reads return only link-scoped fields and do not create relationships',async()=>{
 const endpoint=`https://portal.example/users/receiver/contact/${grantId}`,signed=endpoint+'?sig=opaque-signed-capability';let inspections=0;
 const grant={id:grantId,owner:recipient,quarantined:false,privateState:'not public'};
 const rows=new Map([['beam/profile',{owner:recipient,displayName:'Chosen name',bio:'Private',avatar:'https://images.example/private.png',discloseToContacts:true}],['beam/grant/'+grantId,{beamEnabled:false,profileFields:['displayName']}]]);
 const service=new BeamContacts({metadata:{get:async id=>rows.get(id),put:async()=>assert.fail('public GET must not create a contact')},endpoints:{inspect:async url=>{assert.equal(url,signed);inspections++;return {grant,endpoint};}}});
 assert.deepEqual(await service.publicProfile(recipient,signed),{identityURI:'https://portal.example/users/receiver',beamEnabled:false,profile:{displayName:'Chosen name'}});
 assert.equal(inspections,1);
 grant.quarantined=true;
 await assert.rejects(service.publicProfile(recipient,signed),{code:'contact_quarantined'});
});

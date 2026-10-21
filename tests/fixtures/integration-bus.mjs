// EV-4 extension of the integration fixture vocabulary, composed separately so the X9 verifier stays untouched.
// Test-only, in-memory and default off. Opaque tokens represent ALREADY VERIFIED brokered claims; this is neither
// a JWT/DPoP verifier nor a production host. All mutations and reads pass through ngin Actions/Queries.
import {AppAction,AppQuery,createAppEngine,perform,read} from '../../packages/app/engine.mjs';
import {memoryAudit} from '../../packages/app/providers.mjs';
import {fakeClock} from '../helpers/chaos.mjs';
import {INTEGRATION,ISSUER,SUBJECT,CONNECTION,ENDPOINTS} from './integration-server.mjs';
import {validateBusManifest} from '../../packages/federation/event-buses.mjs';
import {canonical} from '../../packages/core/primitives.mjs';
import {digest} from '../../packages/core/records.mjs';
import {busKeys,mintCursor,openCursor,checkRecord,jsonBytes,EVENT_BUS_CONTRACT} from '../../packages/events/index.mjs';

export const BUS_MANIFEST='https://tasks.example/buses/changes/v1',BUS_RESOURCE=INTEGRATION+'/r/task-changes';
export const busManifest=(spec={})=>({id:BUS_MANIFEST,title:'Task changes',description:'A small ordered task feed.',publisher:'https://tasks.example',
 fields:{bus:{title:'Task changes',type:'resource',cardinality:{min:0,max:1},contracts:[EVENT_BUS_CONTRACT]}},
 slot:{v:1,crit:['bus'],field:'bus',selection:'exclusive',consumers:['application','provider'],bus:{v:1,types:['created','completed'],
  payload:{type:'object',additionalProperties:false,required:['task'],properties:{task:{type:'string',maxLength:4096},n:{type:'integer',minimum:0,maximum:100}}},
  max_record_bytes:256,retention:{min_seconds:0,max_seconds:3600},publishers:['application'],readers:['application'],history:'owner-choice',
  effects:{read:{en:'Read task changes.'},write:{en:'Publish task changes.'}},...spec}}});
export const clientId=name=>`https://${name}.example/bindle/client.json`;
const clone=value=>structuredClone(value),plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const exact=(value,keys)=>{if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('invalid_args');};

export class ConfigureIntegrationBus extends AppAction {
 static operation='fixture.bus.configure';static deps=['federation'];
 run({federation}){return federation.control(this.input);}
}
export class PublishIntegrationBus extends AppAction {
 static operation='fixture.bus.publish';static deps=['federation'];
 run({federation}){return federation.invoke(this.input);}
}
export class ReadIntegrationBus extends AppQuery {
 static operation='fixture.bus.read';static deps=['federation'];
 fetch({federation}){return federation.invoke(this.input);}
}
export class IntegrationBusSnapshot extends AppQuery {
 static operation='fixture.bus.snapshot';static deps=['federation'];
 fetch({federation}){return federation.snapshot();}
}

/** Third-party suite adapter: control supplies test issuer/owner controls, call executes the host's actual RPC.
 * Never ship this fixture. `introspect(claims)` is a trusted injected live provider check; errors fail closed.
 * Its default fake records every attempt, including journal replays, and models revocation/outages/budget denial.
 */
export async function createIntegrationBus({enabled=false,manifest=busManifest(),limits:overrides={},introspect,clock=fakeClock(Date.UTC(2026,9,20))}={}){
 const pins=new Map(),buses=new Map(),tokens=new Map(),grants=new Map(),introspections=[];
 const keys=await busKeys({EVENT_BUS_CURSOR_KEY:new Uint8Array(32).fill(17)});
 let serial=0,closed=false,mode='active',loseReply=false,tail=Promise.resolve();
 const gated=work=>{const next=tail.then(work);tail=next.catch(()=>{});return next;};
 const check=()=>{if(closed||!enabled)fail('not_found',404);};
 const now=()=>Math.floor(clock.now()/1000),authority=claims=>JSON.stringify([claims.iss,claims.sub,claims.client_id,claims.bindle.resource]);
 const pin=async(document,expected)=>{
  let valid;try{valid=validateBusManifest(document,document?.id);}catch{fail('unsupported_fragment');}
  if(valid.status!=='valid')fail('unsupported_fragment');
  const hash='sha256-'+await digest(globalThis.crypto,canonical(document));
  if(expected!==undefined&&hash!==expected)fail('digest_mismatch');
  if(pins.has(document.id)&&pins.get(document.id).digest!==hash)fail('schema_changed');
  const pinned={manifest:clone(document),digest:hash};pins.set(document.id,pinned);return clone(pinned);
 };
 const create=async(document,resource)=>{
  const pinned=await pin(document),spec=pinned.manifest.slot.bus;
  if(buses.has(resource))fail('resource_exists');
  const limits={maxRecordBytes:spec.max_record_bytes,retentionSeconds:spec.retention.max_seconds,maxRetainedRecords:100,maxRetainedBytes:65536,
   publishPerMinute:120,maxWaitSeconds:0,push:false,txRetentionSeconds:Math.max(600,Math.min(86400,spec.retention.max_seconds)),maxRequestBytes:32768,maxResultBytes:262144,...overrides};
  if(limits.retentionSeconds<spec.retention.min_seconds||limits.retentionSeconds>spec.retention.max_seconds||limits.maxRecordBytes>spec.max_record_bytes||limits.push!==false||limits.txRetentionSeconds<Math.max(600,Math.min(86400,spec.retention.max_seconds)))fail('unsupported_fragment');
  buses.set(resource,{resource,manifest:document.id,digest:pinned.digest,spec:clone(spec),limits,incarnation:crypto.randomUUID(),head:0,rows:[],journal:new Map(),stamps:[]});
  return {resource,manifest:document.id,digest:pinned.digest,limits:clone(limits)};
 };
 const trim=bus=>{
  bus.rows=bus.rows.filter(row=>row.published_at+bus.limits.retentionSeconds>now());
  while(bus.rows.length>bus.limits.maxRetainedRecords||bus.rows.reduce((sum,row)=>sum+jsonBytes(row),0)>bus.limits.maxRetainedBytes)bus.rows.shift();
  for(const [key,entry]of bus.journal)if(entry.until<=now())bus.journal.delete(key);
 };
 const verify=(token,envelope)=>{
  const claims=tokens.get(token),binding=claims?.bindle;
  if(!claims||claims.iss!==ISSUER||claims.sub!==SUBJECT||claims.aud!==ENDPOINTS.rpc||claims.exp<=now()||claims.iat>now()||binding?.purpose!=='invoke'||binding.connection!==CONNECTION||binding.generation!==1)fail('invalid_token',401);
  const grant=grants.get(authority(claims));if(grant?.acknowledged||!grant)fail('forbidden',403);
  const bus=buses.get(envelope.resource);
  if(!bus||binding.resource!==envelope.resource||envelope.contract!==EVENT_BUS_CONTRACT||!binding.methods?.[EVENT_BUS_CONTRACT]?.includes(envelope.method)||binding.fragment!==bus.manifest||binding.digest!==bus.digest)fail('forbidden',403);
  return {claims,binding,bus,grant};
 };
 const live=async(claims,grant)=>{
  introspections.push({client:claims.client_id,grant:claims.bindle.grant,resource:claims.bindle.resource,at:now()});
  let result;try{result=introspect?await introspect(clone(claims)):mode==='outage'?await Promise.reject(new Error('offline')):{active:mode==='active'&&grant.active&&grant.methods.includes('publish')};}catch{fail('forbidden',403);}
  if(result?.active!==true)fail('forbidden',403);
 };
 const readPage=async({claims,binding,bus},args)=>{
  exact(args,['cursor','start','limit','wait']);const limit=args.limit??50,wait=args.wait??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isFinite(wait)||wait<0||wait>25||args.cursor!==undefined&&args.start!==undefined||args.start!==undefined&&!['oldest','latest'].includes(args.start))fail('invalid_args');
  const floor=binding.bus;if(!plain(floor)||!Number.isSafeInteger(floor.floor_at)||floor.floor_at<0||typeof floor.history!=='boolean'||floor.history&&bus.spec.history!=='owner-choice')fail('forbidden',403);
  const hidden=floor.history?0:bus.stamps.reduce((position,time,index)=>time<=floor.floor_at?index+1:position,0),client=authority(claims),nonce=canonical(floor);
  let position=args.start==='oldest'?hidden:bus.head;
  if(args.cursor!==undefined){
   const state=await openCursor(keys,{owner:SUBJECT,bus:bus.resource,client},args.cursor);
   if(state.incarnation!==bus.incarnation||state.floor!==0||state.nonce!==nonce)fail('invalid_args');position=Math.max(state.position,hidden);
  }
  // No cleanup on read: this Query neither creates reader state nor advances a host-held cursor.
  const rows=bus.rows.filter(row=>row.published_at+bus.limits.retentionSeconds>now()&&(floor.history||row.published_at>floor.floor_at));
  const visibleHead=bus.head>hidden?bus.head:null,oldest=rows[0]?.seq??null,lostTo=(oldest??bus.head+1)-1;
  const gap=position<lostTo&&lostTo>hidden?{from:Math.max(position+1,hidden+1),to:lostTo}:null;
  if(gap)position=gap.to;
  const records=[];for(const row of rows){if(row.seq<=position)continue;if(records.length===limit)break;
   if(jsonBytes({records:[...records,row]})>bus.limits.maxResultBytes-1024)break;records.push(clone(row));}
  position=records.at(-1)?.seq??position;
  // The shared cursor codec's numeric floor is a seq. Bind the brokered time floor in its authenticated nonce.
  const cursor=await mintCursor(keys,{owner:SUBJECT,bus:bus.resource,client},{incarnation:bus.incarnation,floor:0,nonce,position});
  return {records,cursor,head:visibleHead,oldest,gap};
 };
 const provider={
  async control(input){check();return gated(async()=>{
   const {op}=input;
   if(op==='pin')return pin(input.manifest,input.digest);
   if(op==='create')return create(input.manifest,input.resource);
   if(op==='approve'){
    const client=input.client??'reader',resource=input.resource??BUS_RESOURCE,bus=buses.get(resource);if(!bus)fail('not_found',404);
    // fragment/digest are fixture issuer metadata for the approval pin, not added normative token claims.
    const claims={iss:ISSUER,sub:SUBJECT,aud:ENDPOINTS.rpc,client_id:clientId(client),iat:now(),exp:now()+300,
     bindle:{v:1,purpose:'invoke',connection:CONNECTION,generation:1,resource,grant:input.grant??'grant-'+(++serial),fragment:bus.manifest,digest:bus.digest,
      methods:{[EVENT_BUS_CONTRACT]:input.methods??['read']},bus:{floor_at:input.floorAt??now(),history:input.history===true}}};
    if(input.history&&bus.spec.history!=='owner-choice')fail('forbidden',403);
    Object.assign(claims,input.claims);if(input.binding)Object.assign(claims.bindle,clone(input.binding));
    const token='fixture-bus-token-'+(++serial);tokens.set(token,clone(claims));
    grants.set(authority(claims),{active:true,methods:clone(input.methods??['read']),acknowledged:false});return token;
   }
   if(op==='revoke'){const claim=tokens.get(input.token),grant=claim&&grants.get(authority(claim));if(grant){grant.active=false;grant.acknowledged=input.acknowledged===true;}return {revoked:true};}
   if(op==='introspection'){mode=input.mode;return {mode};}
   if(op==='lose-reply'){loseReply=true;return {armed:true};}
   if(op==='advance'){clock.advance(input.seconds*1000);for(const bus of buses.values())trim(bus);return {now:now()};}
   if(op==='purge'){const bus=buses.get(input.resource??BUS_RESOURCE);bus.rows=[];return {purged:true};}
   fail('unsupported_method');
  });},
  async invoke({token,envelope}){
   check();exact(envelope,['resource','contract','method','args','tx']);
   const verified=verify(token,envelope),{claims,bus,grant}=verified;
   if(['subscribe','unsubscribe'].includes(envelope.method))fail('unsupported_method');
   if(envelope.method==='describe')return {id:bus.resource,manifest:bus.manifest,digest:bus.digest,limits:clone(bus.limits)};
   if(envelope.method==='read')return readPage(verified,envelope.args??{});
   if(envelope.method!=='publish')fail('unsupported_method');
   exact(envelope.args,['type','data']);if(typeof envelope.tx!=='string'||!envelope.tx||envelope.tx.length>128)fail('invalid_args');
   if(jsonBytes(envelope)>bus.limits.maxRequestBytes||!checkRecord(bus.spec,envelope.args,bus.limits.maxRecordBytes).ok)fail('invalid_args');
   // In particular, authorization happens BEFORE consulting a receipt, never from its cached success.
   await live(claims,grant);
   return gated(async()=>{
    trim(bus);const journalKey=canonical([claims.iss,claims.sub,claims.client_id,envelope.tx]),fingerprint=canonical([envelope.resource,envelope.contract,envelope.method,envelope.args]);
    const previous=[...buses.values()].map(value=>value.journal.get(journalKey)).find(entry=>entry&&entry.until>now());
    if(previous){if(previous.fingerprint!==fingerprint)fail('tx_conflict');return clone(previous.result);}
    const seq=bus.head+1,published_at=now(),publisher={kind:'application',client_id:claims.client_id,origin:new URL(claims.client_id).origin};
    const row={seq,type:envelope.args.type,published_at,publisher,attested_by:INTEGRATION,data:clone(envelope.args.data)},result={receipt:'receipt-'+crypto.randomUUID(),published_at};
    bus.rows.push(row);bus.stamps.push(published_at);bus.head=seq;bus.journal.set(journalKey,{fingerprint,result,until:now()+bus.limits.txRetentionSeconds});trim(bus);
    if(loseReply){loseReply=false;fail('indeterminate',503);}return clone(result);
   });
  },
  snapshot(){check();return clone({introspections,buses:[...buses.values()].map(({journal,...bus})=>({...bus,journal:[...journal]}))});}
 };
 const audit=memoryAudit({clock}),engine=createAppEngine({providers:{clock,random:{uuid:()=>crypto.randomUUID()},audit,federation:provider}});
 const control=input=>perform(engine,new ConfigureIntegrationBus({input}));
 const call=(token,method,args={},tx,resource=BUS_RESOURCE)=>{
  const Operation=['read','describe'].includes(method)?ReadIntegrationBus:PublishIntegrationBus;
  const operation=new Operation({input:{token,envelope:{resource,contract:EVENT_BUS_CONTRACT,method,args,...tx!==undefined?{tx}:{}}}});
  return Operation===ReadIntegrationBus?read(engine,operation):perform(engine,operation);
 };
 try{if(enabled)await control({op:'create',manifest,resource:BUS_RESOURCE});}catch(error){await engine.dispose();throw error;}
 return {engine,provider,clock,audit,control,call,origin:INTEGRATION,resource:BUS_RESOURCE,manifest:clone(manifest),
  snapshot:()=>read(engine,new IntegrationBusSnapshot()),async close(){closed=true;tokens.clear();await engine.dispose();}};
}

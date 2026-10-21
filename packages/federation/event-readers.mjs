// Read-approval identity survives widening; revoking the last read ends its cursor epoch.
import {EVENT_BUS_CONTRACT} from './event-buses.mjs';
const key=(kind,id)=>`federation/${kind}/${id}`;
export async function syncEventReaders(s,subject){
 if(!s.eventBusReader)return;
 const changes=await s.store.transaction(async tx=>{
  const live=new Map(),connections=new Map();for(const {value:g}of await tx.list(key('grant',''))){if(!g.active||g.subject!==subject)continue;if(s.connections){const name=`${g.clientId}|${g.connection?.id}|${g.connection?.generation}`;if(!connections.has(name)){let valid=false;try{valid=!!g.connection&&await s.connections.check(g.connection,g.clientId)===true;}catch(error){if(!['invalid_token','unauthorized','not_found'].includes(error.code))throw error;}connections.set(name,valid);}if(!connections.get(name))continue;}
   for(const [field,contracts]of Object.entries(g.methods??{}))if(contracts[EVENT_BUS_CONTRACT]?.includes('read'))for(const resource of g.resources[field]??[]){const r=await tx.get(key('resource',resource));if(!r?.contracts?.[EVENT_BUS_CONTRACT])continue;const id=resource.split('/buses/')[1];if(!id)continue;const name=key('bus-reader',`${subject}|${g.clientId}|${id}`),prior=live.get(name),stored=await tx.get(name),readSince=(stored?.connection?.id===g.connection?.id&&stored?.connection?.generation===g.connection?.generation?stored.readSince:null)??prior?.readSince??g.readSince??g.id;if(g.readSince!==readSince){g.readSince=readSince;await tx.set(key('grant',g.id),g);}if(!prior||g.approvedAt<prior.at)live.set(name,{id,clientId:g.clientId,readSince,at:g.approvedAt,...g.connection?{connection:structuredClone(g.connection)}:{}});}}
  const changes=[];for(const {key:name,value:old}of await tx.list(key('bus-reader',`${subject}|`)))if(!live.has(name))changes.push({name,old});for(const [name,value]of live){const old=await tx.get(name);if(old?.readSince!==value.readSince)changes.push({name,old,value});}return changes;
 });
 for(const {name,old,value}of changes){if(old)await s.eventBusReader({operation:'revoked',id:old.id,input:{clientId:old.clientId}});if(value)await s.eventBusReader({operation:'approved',id:value.id,input:{clientId:value.clientId,readSince:value.readSince}});await s.store.transaction(tx=>value?tx.set(name,value):tx.delete(name));}
}

// Trusted X6 send-time port. Re-check the same pinned assignment and read epoch as a resource RPC; never use a
// cached token or a browser's grant projection to authorize a doorbell. No family refresh or grant widening occurs.
export async function eventDoorbellGrant(s,{owner,bus,clientId,connection,generation,epoch}={}){
 if(owner!==s.routingKey||typeof bus!=='string'||!/^[a-f0-9-]{36}$/.test(bus)||typeof clientId!=='string'||typeof connection!=='string'||typeof epoch!=='string'||!Number.isSafeInteger(generation)||generation<1)return false;
 const subject=`${s.issuer}/entities/${owner}`,identity=await s.incrementalIdentity?.(subject);if(!identity)return false;
 await s.active(subject,identity.epoch);await s.ensureClients();if(!s.clients.has(clientId))return false;
 const resource=`${subject}/buses/${bus}`;
 return s.store.transaction(async tx=>{
  const r=await tx.get(key('resource',resource));if(r?.owner!==subject||!['read','subscribe'].every(m=>r.contracts?.[EVENT_BUS_CONTRACT]?.includes(m)))return false;
  for(const {value:g}of await tx.list(key('grant',''))){
   if(!g.active||g.subject!==subject||g.epoch!==identity.epoch||g.clientId!==clientId||g.connection?.id!==connection||g.connection?.generation!==generation||`grant:${g.readSince??g.id}`!==epoch||(g.resourceGenerations?.[resource]??null)!==(r.generation??null))continue;
   // The caller fences the same connection generation in the account-store transaction. Calling back into
   // the account's gate here would deadlock a subscribe RPC already running inside that gate.
   const prefs=await tx.get(key('preferences',`${subject}|${g.fragment}`)),pin=await tx.get(key('schema',g.fragment));if(!prefs||prefs.digest!==g.digest||pin?.digest!==g.digest)continue;
   for(const [field,ids]of Object.entries(g.resources??{})){
    if(!ids.includes(resource)||!['read','subscribe'].every(m=>g.methods?.[field]?.[EVENT_BUS_CONTRACT]?.includes(m)))continue;
    const spec=pin.schema.fields[field];if(spec?.type!=='resource')continue;const assigned=(spec.cardinality?.max??1)===1?[prefs.values?.[field]]:prefs.values?.[field];
    const current=assigned?.find(v=>(typeof v==='string'?v:v?.resource)===resource);if(!current)continue;
    // Event bus grants have no storage-scoping semantics. Refuse scoped assignments rather than silently ignoring one.
    if(Object.keys((typeof current==='object'?current.scope:null)??{}).length||Object.keys(g.resourceScopes?.[field]?.[resource]??{}).length)continue;
    return true;
   }
  }return false;
 });
}

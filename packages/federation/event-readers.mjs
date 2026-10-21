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

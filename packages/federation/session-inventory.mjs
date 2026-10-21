import {fail,exact} from './schema.mjs';
import {revokeFamily,endLineage,lineageLive,NO_EXPIRY} from './app-sessions.mjs';
const key=(kind,id)=>`federation/${kind}/${id}`;
export async function appSessionInventory(s,authority,input){
 const subject=await s.owner(authority),lineages=await s.appSessionLineage?.(subject)??[];
 if(input!==undefined){exact(input,['id','all']);if(input.all!==true&&typeof input.id!=='string'||input.all===true&&input.id!==undefined)fail('invalid_args');}
 const ended=[];const result=await s.store.transaction(async tx=>{
  const sessions=[];for(const {value:f}of await tx.list(key('family',''))){if(f.subject!==subject||f.status!=='active'||f.expiresAt<=s.clock()||f.idleExpiresAt<=s.clock())continue;
   if(input&&(input.all===true||input.id===f.familyId)){await revokeFamily(s,tx,f);ended.push(f);continue;}
   const live=await lineageLive(s,f);if(!live)continue;if(s.connections&&(!f.connection||await s.connections.check(f.connection,f.clientId)!==true))continue;
   const lineage=lineages.find(l=>l.id===f.lineage?.lineageId),chain=lineage?.sessions??f.approvalChain??[];
   sessions.push({id:f.familyId,clientId:f.clientId,client:structuredClone(s.clients.get(f.clientId)),active:true,createdAt:f.createdAt??lineage?.createdAt??null,lastUsedAt:f.lastUsedAt??null,expiresAt:f.expiresAt>=NO_EXPIRY?null:f.expiresAt,idleExpiresAt:f.idleExpiresAt,approvedFrom:chain[0]??f.approvedFrom??null,approvalChain:[...chain],grantType:f.grantType,grants:[...f.grants]});
  }return input?{revoked:ended.length}:{sessions};
 });if(input){await endLineage(s,ended);if(input.all!==true&&!ended.length)fail('not_found');}return result;
}

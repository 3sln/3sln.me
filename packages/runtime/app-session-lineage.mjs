// Derive an independent approval lineage for an incremental app session. The owner CAS races explicit sign-out.
import {LINKED,pruneLineage} from '../identity/linked-approval.mjs';
import {federationEpoch} from './federation.mjs';
const fail=()=>{throw Object.assign(new Error('Application approval is no longer active.'),{code:'invalid_grant'});};
export function appSessionDerivation({repository,owner}){
 return async({source,familyId,expiresAt,epoch})=>{
  if(!source.lineage)return {approvedFrom:source.approvedFrom??null,approvalChain:source.approvalChain??[]};
  const lineageId=crypto.randomUUID();for(let attempt=0;attempt<3;attempt++){
   const account=await repository.get(owner);if(account?.status!=='active'||await federationEpoch(account)!==epoch)fail();const revision=account.revision,now=Date.now();pruneLineage(account,now);
   const parent=account.linkedLineage?.find(l=>l.id===source.lineage.lineageId&&l.clientId===source.clientId&&l.families.includes(source.familyId));if(!parent||account.linkedLineage.length>=LINKED.lineageLimit)fail();
   if(parent.sessionExpiresAt>now&&parent.sessions.some(id=>!account.sessions.some(s=>s.id===id&&s.expiresAt>now)))fail();
   account.linkedLineage.push({...parent,id:lineageId,families:[familyId],createdAt:now,expiresAt:Math.min(parent.expiresAt??Number.MAX_SAFE_INTEGER,expiresAt)});
   const approving=account.sessions.find(s=>s.id===parent.sessions[0]);if(approving)approving.derivedFamilies=[...approving.derivedFamilies??[],familyId];account.revision=revision+1;
   if(await repository.compareAndSwap(owner,revision,account))return {lineage:{owner,lineageId},approvedFrom:parent.sessions[0],approvalChain:[...parent.sessions]};
  }fail();
 };
}

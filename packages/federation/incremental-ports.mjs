import {clientSite} from './client-metadata.mjs';
import {syncEventReaders} from './event-readers.mjs';
// Trusted owner-shard ports for incremental consent. No HTTP caller supplies these operations.
import {fail,validateValue} from './schema.mjs';
import {createAppSession,revokeFamily,lineageLive,NO_EXPIRY} from './app-sessions.mjs';
const key=(kind,id)=>`federation/${kind}/${id}`,copy=structuredClone,union=(a=[],b=[])=>[...new Set([...a,...b])];
const view=rows=>rows.length?rows.reduce((out,g)=>{out.fields=union(out.fields,g.fields);for(const [f,cs]of Object.entries(g.methods??{}))for(const [c,ms]of Object.entries(cs))(out.methods[f]??={})[c]=union(out.methods[f][c],ms);for(const [f,ids]of Object.entries(g.resources??{}))out.resources[f]=union(out.resources[f],ids);return out;},{fields:[],methods:{},resources:{}}):null;
export async function incrementalPort(s,method,input){
 const {subject,clientId,fragment}=input??{};if(subject!==`${s.issuer}/entities/${s.routingKey}`)fail('forbidden');
 await s.ensureClients();const identity=await s.incrementalIdentity?.(subject);if(!identity)fail('unauthorized');await s.active(subject,identity.epoch);
 const connection=async()=>{const c=await s.connections?.binding(clientId);if(!c||await s.connections.check(c,clientId)!==true)fail('invalid_request');return {...c,appOrigin:s.clients.get(clientId)?.origin};};
 const rows=async tx=>{let c;try{c=await connection();}catch(error){if(['invalid_request','invalid_token','unauthorized','not_found'].includes(error.code))return [];throw error;}return (await tx.list(key('grant',''))).map(r=>r.value).filter(g=>g.active&&g.subject===subject&&g.clientId===clientId&&g.epoch===identity.epoch&&g.connection?.id===c.id&&g.connection?.generation===c.generation);};
 if(method==='siteConnection'){for(const client of s.clients.values()){if(clientSite(new URL(client.origin).hostname)!==input.site)continue;const binding=await s.connections?.binding(client.id);try{if(binding&&await s.connections.check(binding,client.id)===true)return true;}catch(error){if(!['invalid_token','unauthorized','not_found'].includes(error.code))throw error;}}return false;}
 if(method==='connection'){try{return await connection();}catch{return null;}}
 if(method==='current')return s.store.transaction(async tx=>view((await rows(tx)).filter(g=>g.fragment===fragment)));
 if(['read','receivers','candidates'].includes(method)){
  await s.syncResources(subject);const schema=method==='candidates'?(await s.schema(fragment)).schema:null;return s.store.transaction(async tx=>{if(method==='read')return await tx.get(key('preferences',`${subject}|${fragment}`))??null;
   if(method==='receivers')return (await s.consumerSnapshot(tx,subject,fragment,identity.epoch)).consumers.filter(c=>c.client!==clientId&&c.fields?.includes(input.field));
   return (await tx.list(key('resource',''))).map(r=>r.value).filter(r=>r.owner===subject&&schema.fields[input.field]?.contracts?.every(c=>r.contracts[c])).map(r=>({id:r.id,label:r.label,origin:new URL(r.id).origin}));});
 }
 if(method==='save'){
  // The entry engine has checked shared-field acknowledgement; retain the service's schema/resource/revision checks.
  const authority={incremental:true}; // Never replace service authentication: use a scoped facade.
  const scoped=Object.create(s);scoped.authenticateOwner=async()=>({subject,epoch:identity.epoch});
  const snapshot=await s.store.transaction(tx=>s.consumerSnapshot(tx,subject,fragment,identity.epoch));
  return scoped.configure(authority,{fragment,values:input.values,expectedRevision:input.expectedRevision,reviewedConsumerDigest:snapshot.digest,updateShared:true});
 }
 if(method==='commit'){
  await s.syncResources(subject);const c=await connection(),pins=new Map();for(const change of input.changes)pins.set(change.fragment,await s.schema(change.fragment));
  const committed=await s.store.transaction(async tx=>{
   const journal=key('incremental-decision',`${subject}|${clientId}|${input.decision}`),prior=await tx.get(journal);if(prior){if(prior.connection?.id!==c.id||prior.connection?.generation!==c.generation)fail('unauthorized');return {results:prior.results};}
   await s.active(subject,identity.epoch);if(await s.connections.check(c,clientId)!==true)fail('unauthorized');const results=[];
   for(const change of input.changes){const pin=pins.get(change.fragment);if(pin.digest!==change.digest)fail('stale_consent');const preferences=await tx.get(key('preferences',`${subject}|${change.fragment}`));if(!preferences||preferences.digest!==pin.digest)fail('invalid_preferences');
    const before=view((await rows(tx)).filter(g=>g.fragment===change.fragment)),after=view([before??{fields:[],methods:{},resources:{}},change]);
    const resources=after.resources??{},assignedResources={},resourceScopes={},resourceGenerations={};
    for(const f of after.fields){const field=pin.schema.fields[f];if(!field)fail('invalid_args');validateValue(field,preferences.values[f],v=>s.url(v));if(field.type!=='resource')continue;
     const values=(field.cardinality?.max??1)===1?[preferences.values[f]]:preferences.values[f];assignedResources[f]=values.map(v=>typeof v==='string'?v:v.resource);resourceScopes[f]={};
     for(const id of resources[f]??[]){if(!assignedResources[f].includes(id))fail('invalid_resource');const r=await tx.get(key('resource',id));if(!r||r.owner!==subject)fail('invalid_resource');resourceGenerations[id]=r.generation??null;resourceScopes[f][id]=values.find(v=>(typeof v==='string'?v:v.resource)===id)?.scope??{};
      for(const [contract,ms]of Object.entries(after.methods[f]??{}))if(!field.contracts.includes(contract)||ms.some(m=>!r.contracts[contract]?.includes(m)))fail('invalid_args');}
    }
    const id=s.random();await s.bounded(tx,'grant',256);await tx.set(key('grant',id),{id,subject,clientId,fragment:change.fragment,digest:pin.digest,...after,active:true,epoch:identity.epoch,connection:copy(c),assignedResources,approvedResources:copy(resources),resourceScopes,resourceGenerations,approvedAt:s.clock()});results.push({fragment:change.fragment,before,after});
   }
   await s.bounded(tx,'incremental-decision',512);const result={results};await tx.set(journal,{...result,connection:copy(c),expiresAt:s.clock()+86400000});return result;
  });await syncEventReaders(s,subject);return committed;
 }
 if(method==='newest'||method==='issue'){
  const c=await connection();return s.store.transaction(async tx=>{
   const families=(await tx.list(key('family',''))).map(r=>r.value).filter(f=>f.subject===subject&&f.clientId===clientId&&f.status==='active'&&f.epoch===identity.epoch&&f.expiresAt>s.clock()&&f.idleExpiresAt>s.clock()&&f.connection?.id===c.id&&f.connection?.generation===c.generation).sort((a,b)=>(b.createdAt??b.lastUsedAt)-(a.createdAt??a.lastUsedAt));
   let newest;for(const f of families)if(await lineageLive(s,f)){newest=f;break;}if(!newest)return null;
   if(method==='newest')return {expiresAt:Math.min(newest.expiresAt,newest.idleExpiresAt),authTime:newest.authTime};
   // Preserve the existing proof binding and lineage; an incremental entry cannot downgrade a bound family.
   if((newest.jkt??null)!==(input.dpopJkt??null))fail('invalid_dpop_proof');
   const familyId=s.random(),expiresAt=Math.min(input.notAfter??NO_EXPIRY,newest.expiresAt,newest.idleExpiresAt),derived=await s.deriveAppSession?.({source:newest,familyId,expiresAt,epoch:identity.epoch});if(newest.lineage&&!derived?.lineage)fail('invalid_grant');
   const authority={subject,clientId,epoch:identity.epoch,connection:copy(c),grants:(await rows(tx)).map(g=>g.id),authTime:input.authTime,approvedFrom:derived?.approvedFrom??newest.approvedFrom??null,approvalChain:derived?.approvalChain??newest.approvalChain??[]};
   const issued=await createAppSession(s,tx,authority,input.dpopJkt,{familyId,expiresAt,...newest.access?{access:newest.access}:{},...derived?.lineage?{lineage:derived.lineage}:{}});
   return {...await s.issueAccess(tx,issued.family),refresh_token:issued.refresh_token,refresh_expires_in:issued.refresh_expires_in,family:issued.family.familyId};
  });
 }
 if(method==='revoke')return s.store.transaction(async tx=>{const f=await tx.get(key('family',input.family));if(f?.subject===subject&&f.clientId===clientId)await revokeFamily(s,tx,f);});
 fail('unsupported_method');
}

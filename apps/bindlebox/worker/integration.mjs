// Broker/SET cryptography is an explicit trusted service port; these engine operations recheck local authority
// in the mailbox transaction. No token, snapshot or populated binding is treated as approval by itself.
import {MailboxAction,MailboxQuery,ownerOf,operations} from '../../../packages/bindlebox-engine/engine.mjs';
import {IntakeDeliver} from '../../../packages/bindlebox-engine/domains/intake.mjs';
import {KEYS,readConfig,queueEdge} from '../../../packages/bindlebox-engine/store/mailbox.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
import {PROFILE,MAILBOX_CONTRACT,INTAKE_CONTRACT,LINK_KINDS,LIMITS} from '../../../packages/bindlebox-protocol/index.mjs';
import {APP_BRAND} from './brand.mjs';
const invalid=()=>fault('invalid_input','Invalid integration request.',400),denied=()=>fault('not_authorized','Not authorized.',403);
export const resourceId=config=>new URL(`/bindle/mailbox/${config.principal.subject}`,config.ingress).href;
async function authority(tx,owner,v,{purpose,write=false,method,resource}={}){
 const config=await readConfig(tx),grant=await tx.get('shell:authorization'),floor=await tx.get('shell:generation-floor')??0;
 if(await tx.get('owner')!==owner||!v||v.purpose!==purpose||v.owner!==owner||v.issuer!==config.principal.issuer||!grant?.active||!grant.connection||v.connection!==grant.connection||!Number.isSafeInteger(v.generation)||v.generation<floor||v.generation!==grant.generation)denied();
 if(purpose==='invoke'&&(typeof resource!=='string'||resource!==resourceId(config)||v.resource!==resource||!Array.isArray(v.methods)||!v.methods.includes(method)))denied();
 if(write&&v.live!==true)denied();
 const revoked=await tx.get('shell:revoked-grants')??[];if(revoked.some(r=>r.id===v.grant))denied();return config;
}
export class MailboxDescribe extends MailboxQuery {
 static operation='shell.describe';static deps=['mailboxStore'];
 async fetch({mailboxStore:store}){const owner=ownerOf(this.actor),v=this.input?.verified,config=await authority(store,owner,v,{purpose:'invoke',resource:this.input?.resource,method:'describe'});return {version:1,profiles:[PROFILE],ingress:config.ingress,kinds:LINK_KINDS,limits:{maxParticipants:LIMITS.maxParticipants,maxMessageBytes:LIMITS.maxBodyBytes,maxEnvelopeBytes:LIMITS.maxEnvelopeBytes}};}
}
export class MailboxDiscover extends MailboxQuery {
 static operation='shell.discover';static deps=['mailboxStore'];
 async fetch({mailboxStore:store}){
  const config=await authority(store,ownerOf(this.actor),this.input?.verified,{purpose:'discover'}),q=this.input?.query,contracts=[MAILBOX_CONTRACT,INTAKE_CONTRACT],id=resourceId(config);
  if(!q||q.v!==1||!Array.isArray(q.contracts)||!q.contracts.length||q.contracts.some(c=>!contracts.includes(c))||!Number.isInteger(q.limit??50)||(q.limit??50)<0||(q.limit??50)>100||q.text!=null&&(typeof q.text!=='string'||[...q.text].length>200)||q.ids!=null&&(!Array.isArray(q.ids)||q.ids.length>50||q.ids.some(id=>typeof id!=='string')))invalid();
  if(q.facets!=null&&(typeof q.facets!=='object'||Array.isArray(q.facets))||q.cursor!=null&&(typeof q.cursor!=='string'||q.cursor.length>1024)||q.parent!=null&&(typeof q.parent!=='string'||q.parent.length>2048))invalid();
  if(q.facets&&Object.keys(q.facets).length)fault('unsupported_facet','Unsupported facet.',400);
  if(q.ids!=null&&(q.text!=null||q.parent!=null||q.facets&&Object.keys(q.facets).length))invalid();
  const exists=!q.parent&&!q.cursor&&(!q.ids||q.ids.includes(id))&&(!q.text||APP_BRAND.toLowerCase().includes(q.text.toLowerCase()));
  return q.limit===0?{v:1,items:[],exists}:{v:1,items:exists?[{id,label:APP_BRAND,contracts,container:false,facets_applied:[]}]:[],cursor:null};
 }
}
export class MailboxLinkRevoked extends MailboxAction {
 static operation='shell.link-revoked';static deps=['mailboxStore','clock'];static changes='contacts-changed';
 run({mailboxStore:store,clock}){return store.transaction(async tx=>{
  await authority(tx,ownerOf(this.actor),this.input?.verified,{purpose:'invoke',write:true,resource:this.input?.resource,method:'linkRevoked'});const jti=this.input?.args?.jti;if(typeof jti!=='string'||!jti||jti.length>128)invalid();
  const parent=await tx.get(KEYS.parent(jti));if(!parent)return {};
  if(!parent.revoked){await tx.put(KEYS.parent(jti),{...parent,revoked:true,revokedAt:clock.now(),providerRevoke:'revoked'});await queueEdge(tx,{iss:parent.iss,jti,claimsDigest:parent.claimsDigest,revoked:true});}
  for(const [key]of await tx.list({prefix:`decision/${encodeURIComponent(jti)}/`}))await tx.delete(key);return {};
 });}
}
// Reuse B2's proven admission implementation while wrapping its commit handle with live local broker checks.
export class MailboxPublicIntake extends IntakeDeliver {
 static operation='shell.public-intake';
 async run(resources){const {receive}=resources,store=receive.store,owner=this.actor?.owner,v=this.input?.verified;
  await authority(store,owner,v,{purpose:'invoke',write:true,resource:this.input?.resource,method:'deliver'});
  const guarded={get:key=>store.get(key),list:options=>store.list(options),transaction:work=>store.transaction(async tx=>{await authority(tx,owner,v,{purpose:'invoke',write:true,resource:this.input?.resource,method:'deliver'});return work(tx);})};
  return super.run({...resources,receive:{...receive,store:guarded}});
 }
}
export class MailboxIntegrationEvent extends MailboxAction {
 static operation='shell.integration-event';static deps=['mailboxStore','clock'];
 run({mailboxStore:store,clock}){return store.transaction(async tx=>{
  const owner=ownerOf(this.actor),event=this.input?.event,config=await readConfig(tx),grant=await tx.get('shell:authorization');
  if(await tx.get('owner')!==owner||!event||event.owner!==owner||event.issuer!==config.principal.issuer||!grant?.connection||event.connection!==grant.connection||typeof event.jti!=='string'||!event.jti||event.jti.length>128||!Number.isSafeInteger(event.seq)||event.seq<0)denied();
  const log=await tx.get('shell:set-jtis')??[];if(log.includes(event.jti))return {accepted:true};
  const p=event.payload??{},type=event.type;
  if(type==='connection-revoked'){
   if(!Number.isSafeInteger(p.generation_floor)||p.generation_floor<0)invalid();const floor=Math.max(await tx.get('shell:generation-floor')??0,p.generation_floor);await tx.put('shell:generation-floor',floor);
   if(grant.generation<floor){await tx.put('shell:authorization',{...grant,active:false});await tx.delete('shell:renewal');}
  }else if(type==='credential-revoked'){
   if(!Array.isArray(p.grants)||p.grants.length>1024||p.grants.some(id=>typeof id!=='string'||!id||id.length>256)||!Number.isSafeInteger(p.until))invalid();
   const revoked=new Map((await tx.get('shell:revoked-grants')??[]).filter(r=>r.until>clock.now()).map(r=>[r.id,r]));for(const id of p.grants)revoked.set(id,{id,until:Math.max(revoked.get(id)?.until??0,p.until)});if(revoked.size>1024)fault('recipient_unavailable','Revocation capacity exhausted.',503);await tx.put('shell:revoked-grants',[...revoked.values()]);
  }else if(type==='preferences-updated'){
   if(typeof p.fragment!=='string'||p.fragment.length>2048||p.values===undefined||JSON.stringify(p.values).length>8192)invalid();const key='shell:preferences/'+encodeURIComponent(p.fragment),prior=await tx.get(key);if(!prior&&(await tx.list({prefix:'shell:preferences/'})).size>=8)fault('recipient_unavailable','Configuration capacity exhausted.',503);if(!prior||event.seq>prior.seq)await tx.put(key,{seq:event.seq,values:p.values});
  }
  // Resumption never restores a local grant: trusted provisioning installs the new generation after consent.
  log.push(event.jti);if(log.length>1000)log.shift();await tx.put('shell:set-jtis',log);return {accepted:true};
 });}
}
export const INTEGRATION_OPERATIONS=operations(MailboxDescribe,MailboxDiscover,MailboxLinkRevoked,MailboxPublicIntake,MailboxIntegrationEvent);

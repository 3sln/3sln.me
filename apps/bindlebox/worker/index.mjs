import {DurableObject} from 'cloudflare:workers';
import {createMailbox,enabled} from './mailbox.mjs';
import {workerStore} from './storage.mjs';
import {createHTTP} from './http.mjs';
import {servicePorts} from './ports.mjs';
import {metadataPort} from './metadata.mjs';
import {createEdgeIndex,flushEdgeOutbox,linkClaims} from '../../../packages/bindlebox-engine/store/edge-index.mjs';
import {createConversationEdge,flushConversationEdge} from '../../../packages/bindlebox-engine/domains/conversations.mjs';
import {parseCredential,ProtocolFault,edgeKey} from '../../../packages/bindlebox-protocol/index.mjs';
import {MailboxFault,fault} from '../../../packages/bindlebox-engine/faults.mjs';
// One mailbox per authenticated owner; only this app's Worker/bindings can invoke its RPC methods.
export class MailboxObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.store=workerStore(ctx.storage);this.ready=enabled(env.BINDLEBOX_ENABLED)?ctx.blockConcurrencyWhile(()=>this.store.recover()):Promise.resolve();}
 ports(){return servicePorts({services:this.env.BINDLEBOX_SERVICES,egress:this.env.BINDLEBOX_EGRESS,store:this.store,secret:this.env.BINDLEBOX_KEY_ENCRYPTION_KEY,clientId:this.env.BINDLEBOX_CLIENT_ID});}
 async mailbox(){await this.ready;return this.box??=createMailbox({store:this.store,ports:this.ports(),BINDLEBOX_ENABLED:this.env.BINDLEBOX_ENABLED});}
 async provision(owner,input){const box=await this.mailbox();await box.provision(owner,input);return {configured:true};}
 async invoke(owner,operation,params={}){
  try{const box=await this.mailbox();await box.open(owner);const value=await box.run(owner,operation,params);if(this.env.LINK_INDEX)await flushIndexes(this.store,this.env,owner);return value instanceof Response?{ok:true,response:{status:value.status,headers:[...value.headers],body:await value.text()}}:{ok:true,value};}
  catch(error){return {ok:false,error:{code:error?.code??'internal_error',status:error?.status??500}};}
 }
 async alarm(){if(!enabled(this.env.BINDLEBOX_ENABLED))return;const result=await (await this.mailbox()).alarm(),owner=await this.store.get('owner');if(owner&&this.env.LINK_INDEX)await flushIndexes(this.store,this.env,owner);return result;}
}
// Separate SQLite index objects keep malformed/unknown capabilities away from per-user mailboxes. Keys are
// digests only, as in B2. The full admission transaction always checks the live parent again.
export class LinkIndexObject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.index=createEdgeIndex(workerStore(ctx.storage));}
 async check(header){try{if(!enabled(this.env.BINDLEBOX_ENABLED))fault('not_found','Messaging is disabled.',404);return {ok:true,value:await this.index.check(header)};}catch(error){return {ok:false,error:{code:error?.code??'internal_error',status:error?.status??500}};}}
 publish(entry){if(!enabled(this.env.BINDLEBOX_ENABLED))fault('not_found','Messaging is disabled.',404);return this.ctx.storage.transaction(tx=>createEdgeIndex(tx).publish(entry));}
 async checkConversation(credential,envelope){try{if(!enabled(this.env.BINDLEBOX_ENABLED))fault('not_found','Messaging is disabled.',404);return {ok:true,value:await createConversationEdge(this.store??workerStore(this.ctx.storage)).check(credential,envelope)};}catch(error){return {ok:false,error:{code:error?.code??'internal_error',status:error?.status??500}};}}
 async routeConversation(token){try{if(!enabled(this.env.BINDLEBOX_ENABLED))fault('not_found','Messaging is disabled.',404);return {ok:true,value:await createConversationEdge(workerStore(this.ctx.storage)).route(token)};}catch(error){return {ok:false,error:{code:error?.code??'internal_error',status:error?.status??500}};}}
 publishConversation(entry){if(!enabled(this.env.BINDLEBOX_ENABLED))fault('not_found','Messaging is disabled.',404);return this.ctx.storage.transaction(tx=>createConversationEdge(tx).publish(entry));}
}
function indexStub(env,key){if(!env.LINK_INDEX)fault('recipient_unavailable','Ingress index unavailable.',503);let hash=2166136261;for(const c of key)hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;return env.LINK_INDEX.get(env.LINK_INDEX.idFromName(`links-v1/${hash%64}`));}
function checked(result){if(!result.ok)throw new ProtocolFault(result.error.code,{status:result.error.status});return result.value;}
export function edgeIndex(env){
 const stub=(iss,jti)=>indexStub(env,JSON.stringify([iss,jti]));
 return {check:async header=>{const credential=parseCredential(header);if(credential.scheme!=='BindleLink')fault('not_authorized','Not authorized.',403);const {claims}=linkClaims(credential.value),result=await stub(claims.iss,claims.jti).check(header);if(!result.ok)throw new ProtocolFault(result.error.code,{status:result.error.status});return result.value;},publish:entry=>stub(entry.iss,entry.jti).publish(entry)};
}
export function conversationIndex(env){return {
 async check(credential,envelope){const p=envelope.payload,key=await edgeKey({conversationId:p.record.conversationId,author:{issuer:p.author.principal.issuer,subject:p.author.principal.subject},owner:{issuer:p.recipient.issuer,subject:p.recipient.owner}});return checked(await indexStub(env,'peer:'+key).checkConversation(credential,envelope));},
 async route(token){return checked(await indexStub(env,'route:'+token).routeConversation(token));},
 publish:entry=>indexStub(env,entry.kind==='route'?'route:'+entry.token:'peer:'+entry.key).publishConversation(entry)
};}
async function flushIndexes(store,env,owner){await flushEdgeOutbox(store,edgeIndex(env),owner);await flushConversationEdge(store,conversationIndex(env),owner);}
export default {fetch(request,env){return createHTTP({BINDLEBOX_ENABLED:env.BINDLEBOX_ENABLED,services:env.BINDLEBOX_SERVICES,edge:edgeIndex(env),conversationEdge:conversationIndex(env),metadata:metadataPort({clientId:env.BINDLEBOX_CLIENT_ID,services:env.BINDLEBOX_SERVICES}),authenticate:request=>{if(!env.BINDLEBOX_SERVICES)fault('recipient_unavailable','Authentication unavailable.',503);return env.BINDLEBOX_SERVICES.authenticate({authorization:request.headers.get('Authorization'),method:request.method,url:request.url});},mailbox:async owner=>{if(!env.MAILBOXES)fault('recipient_unavailable','Mailbox unavailable.',503);const stub=env.MAILBOXES.get(env.MAILBOXES.idFromName(owner));return {async run(owner,name,params){const result=await stub.invoke(owner,name,params);if(!result.ok)throw new MailboxFault(result.error.code,undefined,result.error.status);return result.response?new Response(result.response.body,{status:result.response.status,headers:result.response.headers}):result.value;}};}})(request);}};

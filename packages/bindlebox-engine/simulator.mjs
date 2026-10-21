// Local in-memory CLI composition. Reserved .example peers, ephemeral signing keys and a simulated transport;
// no provider service, external network, durable delivery or production capability is implied.
import {createMailboxEngine,operate} from './engine.mjs';
import {MAILBOX_OPERATIONS} from './operations.mjs';
import {memoryEffects} from './providers.mjs';
import {ContactsDomain,ReceiveDomain} from './store/mailbox.mjs';
import {createEdgeIndex,flushEdgeOutbox} from './store/edge-index.mjs';
import {ReceiveDeliver,handleIngress} from './domains/receive.mjs';
import {createOutboxProvider} from './domains/outbox.mjs';
import * as B from '../bindlebox-protocol/index.mjs';
const encoder=new TextEncoder(),ES={name:'ECDSA',namedCurve:'P-256'},pub=({kty,crv,x,y})=>({kty,crv,x,y});
export function memoryMailbox(initial=[]){
 let data=new Map(structuredClone(initial)),tail=Promise.resolve();
 const handle=map=>({get:async k=>structuredClone(map.get(k)),put:async(k,v)=>{map.set(k,structuredClone(v));},set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>map.delete(k),list:async({prefix=''}={})=>new Map([...map].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,structuredClone(v)]))});
 return {get:k=>handle(data).get(k),list:options=>handle(data).list(options),put(k,v){return this.transaction(tx=>tx.put(k,v));},delete(k){return this.transaction(tx=>tx.delete(k));},transaction(work){const result=tail.then(async()=>{const draft=structuredClone(data),value=await work(handle(draft));data=draft;return value;});tail=result.catch(()=>{});return result;}};
}
export async function createMailboxSimulator({count=2,seed=1,clock=memoryEffects().clock}={}){
 if(!Number.isInteger(count)||count<1||count>64)throw new TypeError('Use 1–64 peers');
 const peers=new Map(),edge=createEdgeIndex(memoryMailbox()),trace=[];
 const directory={resolveKey:async({issuer,subject,keyId})=>{const p=[...peers.values()].find(p=>p.principal.issuer===issuer&&p.owner===subject&&p.keyId===keyId);return p?{keyId,publicJwk:p.identity.publicJwk,identityURI:p.principal.identityURI}:null;},status:async()=>({status:'active'})};
 for(let i=0;i<count;i++){
  const name=['alice','bob','carol'][i]??`peer${i+1}`,effects=memoryEffects({seed:seed+i,clock}),owner=effects.random.uuid(),issuer=`https://${name}.provider.example`,identityURI=`${issuer}/identity/${owner}`,keyId=`${identityURI}#k1`,ingress=`https://${name}.box.example/ingress`,principal={issuer,subject:owner,identityURI};
  const identity=await crypto.subtle.generateKey(ES,true,['sign','verify']),delegate=await crypto.subtle.generateKey(ES,true,['sign','verify']),identityJwk=pub(await crypto.subtle.exportKey('jwk',identity.publicKey)),delegateJwk=pub(await crypto.subtle.exportKey('jwk',delegate.publicKey)),jkt=await B.thumbprint(delegateJwk),iat=Math.floor(clock.now()/1000)-60;
  const delegation=await B.encodeDelegation({bindle:'key-delegation',v:1,iss:issuer,sub:owner,delegate:delegateJwk,jkt,purposes:[B.PURPOSES.author,B.PURPOSES.receipt].sort(),client:{client_id:`https://${name}.box.example/client.json`,origin:`https://${name}.box.example`,ingress},cnx:`sim-${name}`,since:iat-86400,jti:`cert-${name}`,iat,exp:iat+86400},{privateKey:identity.privateKey,keyId});
  const peer={name,owner,principal,keyId,ingress,identity:{privateKey:identity.privateKey,publicJwk:identityJwk},signer:{privateKey:delegate.privateKey,delegation,kid:`jkt:${jkt}`},author:{principal,identityDocument:`${identityURI}/identity.json`,keyId,delegate:`jkt:${jkt}`},store:memoryMailbox([['owner',owner]]),audit:effects.audit,effects};peers.set(name,peer);
 }
 for(const peer of peers.values()){
  let serial=0;
  const providerLink={async issue({type,claims}){const jti=`sim-${peer.name}-${++serial}`,iat=Math.floor(clock.now()/1000),aud=`${peer.principal.issuer}/contact/${serial}`,encode=value=>B.base64url(encoder.encode(JSON.stringify(value))),head=`${encode({alg:'ES256',kid:peer.keyId,typ:'bindle-link-meta+jwt'})}.${encode({bindle:'link-meta',v:1,type,iss:peer.principal.issuer,aud,jti,iat,exp:iat+30*86400,...claims})}`,signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},peer.identity.privateKey,encoder.encode(head));return {jti,link:`${aud}?bindle_meta=${head}.${B.base64url(new Uint8Array(signature))}`};},revoke:async()=>({}),evaluate:async()=>({state:'eligible'})};
  const egress={async fetch(url,init){const target=[...peers.values()].find(p=>p.ingress===url);if(!target)throw new Error('Unknown simulated ingress');trace.push({from:peer.name,to:target.name});return handleIngress({url,method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body},{edge,now:clock.now,deliver:(owner,input)=>{if(owner!==target.owner)throw new Error('Wrong simulated mailbox');return operate(target.engine,new ReceiveDeliver({actor:{kind:'ingress',owner},input}));}});}};
  peer.engine=createMailboxEngine({providers:{...peer.effects,mailboxStore:peer.store,contacts:ContactsDomain,receive:ReceiveDomain,directory,delegateKeys:{current:async()=>peer.signer},providerLink,userStorage:null,classifier:null,egress,outbox:createOutboxProvider({BINDLEBOX_ENABLED:true,authorize:()=>true})}});
  peer.run=(op,params={})=>{if(!Object.hasOwn(MAILBOX_OPERATIONS,op))throw new TypeError(`Unknown operation ${op}`);return operate(peer.engine,new MAILBOX_OPERATIONS[op]({actor:{kind:'owner',owner:peer.owner},...params}));};
  await peer.run('receive.configure',{input:{principal:peer.principal,ingress:peer.ingress}});
  // Setup is composition, not a user operation in the CLI audit.
  peer.audit.entries.length=0;
 }
 return {peers,clock,trace,directory,async prepare(from,to,{text='Hello',operationId}={}){
  const sender=peers.get(from),recipient=peers.get(to);if(!sender||!recipient)throw new TypeError('Unknown simulated peer');
  const link=await recipient.run('contacts.create-link');await flushEdgeOutbox(recipient.store,edge,recipient.owner);
  const body=encoder.encode(text),id=operationId??sender.effects.random.uuid(),envelope=await B.signEnvelope({version:1,profile:B.PROFILE,kind:'one-off',noReply:true,operationId:id,createdAt:clock.now(),recipient:{issuer:recipient.principal.issuer,owner:recipient.owner,contactId:link.jti,resource:link.resource},content:await B.contentDescriptor('text/plain',body),subject:'Simulator message',optionalTags:[],author:sender.author},sender.signer);
  return {operationId:id,body,recipients:[{envelope,ingress:recipient.ingress,credential:`BindleLink ${new URL(link.link).searchParams.get('bindle_meta')}`}]};
 },dispose:()=>Promise.all([...peers.values()].map(p=>p.engine.dispose()))};
}

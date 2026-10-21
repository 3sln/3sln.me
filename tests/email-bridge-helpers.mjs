// Shared BRIDGE fixtures: raw mail builder, a recipient directory, recording ports and a Node-adapter world.
import {fakeClock} from './helpers/chaos.mjs';
import {nodeEmailBridge,memoryStore,storeSenders,provenanceSigner,brokeredOccupant} from '../packages/email-bridge/index.mjs';

export const NOW=Date.UTC(2026,9,21,9);
export const ORIGIN='https://3sln.example',DOMAIN='3sln.example',AUTHSERV='mx.3sln.example';
export const OWNER='b0b00000-0000-4000-8000-000000000002',OTHER='ca401000-0000-4000-8000-000000000003';
export const PRINCIPAL={issuer:ORIGIN,subject:OWNER,identityURI:`${ORIGIN}/identity/${OWNER}`};
export const RESOURCE=`https://hub.box.example/bindle/mailbox/${OWNER}`;
export const CONFIG=Object.freeze({EMAIL_BRIDGE_ENABLED:'true',BINDLEBOX_ENABLED:'true',APP_ORIGIN:ORIGIN,EMAIL_BRIDGE_AUTHSERV_ID:AUTHSERV,EMAIL_BRIDGE_AUTHSERV_STRIPS:'true'});
const enc=new TextEncoder();

/** RFC 5322 bytes. `auth` adds the receiver's Authentication-Results; `headers` are extra raw header lines. */
export function rawMail({from='alice@sender.example',header,to=`bob@${DOMAIN}`,subject='Lunch next week?',body='Hi Bob, are you free on Tuesday?',auth='pass',messageId='<m1@sender.example>',headers=[],contentType,raw}={}){
 if(raw)return enc.encode(raw);
 const lines=[`Received: from mail.sender.example by ${AUTHSERV}`,...auth?[`Authentication-Results: ${AUTHSERV}; spf=${auth} smtp.mailfrom=${from}; dkim=${auth} header.d=sender.example; dmarc=${auth} header.from=sender.example`]:[],`From: ${header??`Alice Example <${from}>`}`,`To: <${to}>`,`Subject: ${subject}`,'Date: Wed, 21 Oct 2026 09:00:00 +0000',...messageId?[`Message-ID: ${messageId}`]:[],'MIME-Version: 1.0',...contentType?[]:['Content-Type: text/plain; charset=utf-8'],...headers];
 return enc.encode(`${lines.join('\r\n')}\r\n\r\n${body}\r\n`);
}
export async function bridgeKey(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);return {pair,keyId:`${ORIGIN}/keys/email-bridge/k1`,publicJwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}};}

/** A Node-adapter world with a scriptable occupant. `occupant.mode`: 'none' | 'store' | 'refuse' | 'busy' | 'lost' | 'bad'. */
export async function world({config=CONFIG,mode='store',seat={id:'seat-1',resource:RESOURCE},key,clock=fakeClock(NOW),sendReply=true,call,senders,limiter}={}){
 key??=await bridgeKey();
 const accounts=new Map([['bob',{owner:OWNER,active:true,entitled:true,principal:PRINCIPAL}],['robert',{owner:OWNER,active:true,entitled:true,principal:PRINCIPAL}],['carol',{owner:OTHER,active:true,entitled:true,principal:{issuer:ORIGIN,subject:OTHER,identityURI:`${ORIGIN}/identity/${OTHER}`}}],['dave',{owner:'da7e0000-0000-4000-8000-000000000004',active:false,entitled:true,principal:PRINCIPAL}],['erin',{owner:'e0170000-0000-4000-8000-000000000005',active:true,entitled:false,principal:PRINCIPAL}]]);
 const ownerStores=new Map(),senderStore=memoryStore(),limiterStore=memoryStore(),replies=[],mails=[],deliveries=[],directoryCalls=[],state={mode,seat};
 const stores={for:owner=>{if(!ownerStores.has(owner))ownerStores.set(owner,memoryStore());return ownerStores.get(owner);}};
 const occupant=brokeredOccupant({seat:()=>state.mode==='none'?null:state.seat,call:call??(async({owner,seat:s,body})=>{const rpc=JSON.parse(new TextDecoder().decode(body));deliveries.push({owner,seat:s.id,rpc});
  if(state.mode==='refuse')return {status:200,json:{version:'0',tx:rpc.tx,result:{disposition:'refused'}}};
  if(state.mode==='busy')return {status:503,json:{error:{code:'recipient_unavailable'}}};
  if(state.mode==='bad')return {status:400,json:{error:{code:'malformed'}}};
  if(state.mode==='lost')throw new Error('connection reset');
  return {status:200,json:{version:'0',tx:rpc.tx,result:{disposition:'stored-receipt'}}};})});
 const bridge=nodeEmailBridge({config,clock,stores,occupant,signer:provenanceSigner({privateKey:key.pair.privateKey,keyId:key.keyId}),
  directory:{resolve:async handle=>{directoryCalls.push(handle);return accounts.get(handle)??null;}},limiter:limiter??storeSenders(limiterStore,{clock}),senders:senders??storeSenders(senderStore,{clock}),
  mail:{send:async m=>{mails.push(m);return {messageId:`m${mails.length}`};}},sendReply:typeof sendReply==='function'?sendReply:sendReply?async r=>{replies.push(r);}:undefined});
 const receive=(raw,{from='alice@sender.example',to=`bob@${DOMAIN}`,rawSize=raw.byteLength}={})=>bridge.receive({from,to,raw,rawSize});
 return {bridge,clock,key,state,stores,ownerStores,senderStore,limiterStore,replies,mails,deliveries,directoryCalls,receive,accounts,
  rows:async(owner=OWNER,prefix='')=>[...(await stores.for(owner).list({prefix})).entries()],
  enable:async(owner=OWNER,input={enabled:true})=>bridge.configure(owner,input)};
}
export const text=bytes=>new TextDecoder().decode(bytes);

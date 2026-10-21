// BRIDGE Node adapter (minimal): the same operations behind an injected transport. Node has no Email Routing event
// and no platform-enforced DMARC reply, so a host that feeds it mail (an SMTP relay or test) passes the normalized
// envelope and raw bytes; a reply is produced only with a `sendReply` port AND a dmarc=pass result from the
// configured EMAIL_BRIDGE_AUTHSERV_ID. Stores are injected (apps/node SqliteMetadata files are durable; memoryStore is
// for tests and loopback development only).
import {readBounded} from './mime.mjs';
import {createBridgeEngine,perform,read,BRIDGE_OPERATIONS,BridgeReceive,GENERIC_REFUSAL} from './engine.mjs';

export function nodeEmailBridge({config,directory,limiter,stores,senders,occupant,signer,mail,sendReply,clock={now:()=>Date.now()},random={uuid:()=>crypto.randomUUID()},audit={record(){}}}){
 const owner=(operation,id,input,kind='system')=>{const engine=createBridgeEngine({providers:{config,clock,random,audit,stores,senders,occupant,signer,mail}});const op=new BRIDGE_OPERATIONS[operation]({actor:{kind,owner:id},input});
  return (['bridge.settings','bridge.status'].includes(operation)?read(engine,op):perform(engine,op)).finally(()=>engine.dispose());};
 return {
  /** {from, to, raw: Uint8Array|ReadableStream, rawSize} -> {action:'accept'|'reject', reason?}. */
  async receive({from,to,raw,rawSize}){
   const engine=createBridgeEngine({providers:{config,clock,random,audit,directory,limiter,owners:{admit:(id,input)=>owner('bridge.admit',id,input)}}});let out;
   try{out=await perform(engine,new BridgeReceive({actor:{kind:'edge'},input:{envelope:{from,to},rawSize,read:limit=>raw instanceof Uint8Array?(raw.byteLength>limit?Promise.reject(Object.assign(new Error('too large'),{code:'too_large'})):raw):readBounded(raw,limit),dmarcGate:typeof sendReply==='function'?'trusted':'unavailable'}}));}
   catch{out=null;}finally{engine.dispose();}
   if(out?.action!=='accept')return {action:'reject',reason:GENERIC_REFUSAL};
   if(out.reply){let outcome='sent',code;try{await sendReply({from:out.reply.from,to:out.reply.to,raw:out.reply.raw});}catch(error){outcome='failed';code=typeof error?.code==='string'?error.code:undefined;}try{await owner('bridge.reply-outcome',out.owner,{jti:out.reply.jti,outcome,...code?{code}:{}});}catch{}}
   return {action:'accept',owner:out.owner};
  },
  drain:id=>owner('bridge.drain',id,{}),
  accepted:(id,jti,kind='owner')=>owner('bridge.accepted',id,{jti},kind),
  settings:id=>owner('bridge.settings',id,undefined,'owner'),
  configure:(id,input)=>owner('bridge.configure',id,input,'owner'),
  status:id=>owner('bridge.status',id,undefined,'owner'),
  suppress:address=>owner('bridge.suppress',undefined,{address}),
 };
}

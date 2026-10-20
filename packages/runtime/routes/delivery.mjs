// HTTP routes of slice 4, Inbound delivery and link replay (docs/architecture/app-engine.md §12): contact-delivery bearer RPC, authored delivery to signed contact links, retired anonymous submission.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {parseMultipartDelivery,parseRPCDelivery} from '../../messaging/contact-delivery-wire.mjs';
import {UUID as uuidPattern} from '../../core/primitives.mjs';
import {json,limit,jwsPart,bytesOf,accountHandle} from './shared.mjs';

const delivered=(result,headers)=>json({receipt:result.receipt},202,headers);

/** The POST branch of a signed contact link (routes/contacts.mjs), after the link, recipient and rate limits passed. */
export async function signedContactDelivery({request,local,execution,sub,handle,publicHeaders}){
     // Authored delivery only (links §6.1): the signed URL is the sole credential on this path.
     if(request.headers.has('Authorization'))return json({error:'ambiguous_credentials',message:'Send the signed contact link as the only credential.'},400,publicHeaders);
     const contentType=request.headers.get('Content-Type')||'';if(!contentType.startsWith('multipart/form-data'))return json({error:'unsupported_media',message:'Send a contact-delivery multipart message.'},415,publicHeaders);
     // Credential first (contact-delivery S4): no envelope parsing or hashing for an invalid link.
     await handle.verifyLinkCredential(sub,{url:request.url});
     const bytes=await bytesOf(request,1500000);let operation;
     try{operation=await parseMultipartDelivery(contentType,bytes,{allowInsecureLocalhost:local});}catch(error){if(['invalid_multipart','author_required'].includes(error.code)&&!new TextDecoder().decode(bytes.subarray(0,4096)).includes('name="envelope"'))return json({error:'author_required',message:'Contact links accept only identity-authored messages. Sign in to send.'},403,publicHeaders);throw error;}
     const result=await handle.deliverLink(sub,{url:request.url},{envelope:operation.envelope,body:operation.body,...request.headers.has('Idempotency-Key')?{idempotencyKey:request.headers.get('Idempotency-Key')}:{}});execution?.waitUntil?.(handle.searchDrain(sub,{limit:10}).catch(()=>{}));return delivered(result,publicHeaders);
}
export const stages={
 async public({request,env,execution,path,local}){
   // Contact-delivery bearer RPC: a disjoint credential class, never the OAuth/app grant path.
   if(path==='/bindle/rpc'&&request.method==='POST'&&/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('Authorization')||'')&&jwsPart(request.headers.get('Authorization').slice(7),0)?.typ==='bindle-contact-delivery+jwt'){
    const token=request.headers.get('Authorization').slice(7);if(token.length>16384)return json({error:'unauthorized'},401);
    let ingressRetry=3600;if(!await limit(env,{operation:'message',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown'),onDenied:window=>ingressRetry=Math.ceil(window.windowMs/1000)}))return json({error:'rate_limited'},429,{'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After','Retry-After':String(ingressRetry)});
    const sub=jwsPart(token,1)?.sub;if(typeof sub!=='string'||!uuidPattern.test(sub))return json({error:'unauthorized'},401);const recipient=await env.IDENTITY_REPOSITORY.get(sub);if(!recipient||recipient.status!=='active')return json({error:'unauthorized'},401);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'invalid_envelope',message:'Use the contact-delivery RPC JSON request.'},415);
    const handle=accountHandle(env,sub);await handle.verifyLinkCredential(sub,{token});
    const parsed=await parseRPCDelivery(await bytesOf(request,1500000),{allowInsecureLocalhost:local}),result=await handle.deliverLink(sub,{token},{envelope:parsed.envelope,body:parsed.body});execution?.waitUntil?.(handle.searchDrain(sub,{limit:10}).catch(()=>{}));
    return json({version:'0',tx:parsed.tx,result:result.receipt});
   }
 },
 async anonymous({request,path}){
   // Anonymous inbox-bearer submission is retired: every message through a link is identity-authored (links §6.1, §10).
   const landing=/^\/users\/((?:[a-z0-9][a-z0-9_-]{2,31}|n\.[0-9abcdefghjkmnpqrstvwxyz]{1,9}))\/message$/.exec(path);
   if((path==='/api/messages'||landing)&&request.method==='POST'&&request.headers.get('Authorization')?.startsWith('Bearer '))return json({error:'author_required',message:'Contact links accept only identity-authored messages. Sign in to send.'},403,{'Access-Control-Allow-Origin':'*'});
 },
};

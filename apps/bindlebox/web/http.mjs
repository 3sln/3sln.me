// Mount before the B8 fallback. No provider identity or demo bypass: use B8's live authenticate/mailbox ports.
import {WEB_OPERATIONS,ARCHIVE_WEB_OPERATIONS} from './providers/mailbox.mjs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export function createWebHTTP({BINDLEBOX_ENABLED=false,archiveEnabled=false,authenticate,mailbox}={}){
 return async request=>{
  if(BINDLEBOX_ENABLED!==true||!['/api/web/operation','/api/web/session'].includes(new URL(request.url).pathname))return null;
  try{
   const session=new URL(request.url).pathname==='/api/web/session';
   if(request.method!==(session?'GET':'POST'))return Response.json({error:'method_not_allowed'},{status:405,headers});
   if(request.headers.get('Origin')&&request.headers.get('Origin')!==new URL(request.url).origin)return Response.json({error:'forbidden'},{status:403,headers});
   if(!/^Bearer [^\s]{1,8192}$/.test(request.headers.get('Authorization')??''))return Response.json({error:'unauthorized'},{status:401,headers});
   const actor=await authenticate(request);if(actor?.kind!=='owner'||!/^[a-f0-9-]{36}$/.test(actor.owner??''))return Response.json({error:'unauthorized'},{status:401,headers});
   if(session)return Response.json({owner:actor.owner,archiveEnabled:archiveEnabled===true},{headers});
   if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return Response.json({error:'invalid_input'},{status:415,headers});
   const reader=request.body?.getReader(),chunks=[];let size=0;
   if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>131072){await reader.cancel();return Response.json({error:'too_large'},{status:413,headers});}chunks.push(part.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}let data;
   try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return Response.json({error:'invalid_input'},{status:400,headers});}
   if(!data||Object.keys(data).some(k=>!['name','id','input'].includes(k))||!(WEB_OPERATIONS.includes(data.name)||archiveEnabled===true&&ARCHIVE_WEB_OPERATIONS.includes(data.name))||data.id!==undefined&&(typeof data.id!=='string'||data.id.length>1024)||!data.input||typeof data.input!=='object'||Array.isArray(data.input))return Response.json({error:'invalid_input'},{status:400,headers});
   const box=await mailbox(actor.owner),result=await box.run(actor.owner,data.name,{id:data.id,input:data.input});return Response.json(result??null,{headers});
  }catch(error){const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<600?error.status:503;return Response.json({error:status===503?'recipient_unavailable':error.code??'invalid_input'},{status,headers});}
 };
}

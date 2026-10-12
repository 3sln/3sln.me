const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow, nosnippet','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Range, If-Match, If-None-Match','Access-Control-Expose-Headers':'ETag, Content-Range, X-Bindle-Content-Type, Retry-After'};
const error=(code,status=400,retryAfter)=>new Response(JSON.stringify({error:code}),{status,headers:{...headers,'Content-Type':'application/json',...Number.isSafeInteger(retryAfter)&&retryAfter>0?{'Retry-After':String(retryAfter)}:{}}});
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const base64=bytes=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);};
const parseRange=value=>{const match=/^bytes=(\d+)-(\d+)$/.exec(value??'');if(!match)fail('invalid_range');const start=Number(match[1]),end=Number(match[2]);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end-start>=1048576)fail('invalid_range');return {start,end};};
async function readBytes(request,size){if(!Number.isSafeInteger(size)||size<0||size>1048576)fail('invalid_size');const length=request.headers.get('Content-Length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==size))fail('size_mismatch');const reader=request.body?.getReader();if(!reader){if(size)fail('size_mismatch');return new Uint8Array();}const chunks=[];let count=0;try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>size){await reader.cancel();fail('size_mismatch',413);}chunks.push(value);}}finally{reader.releaseLock();}if(count!==size)fail('size_mismatch');const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;}

/** Signed object capabilities use no ambient session or Authorization header.
 * Authority is checked before consuming an upload and again at dispatch. */
export async function handleObjectURL(request,{controller,enabled}){
 if(!enabled||!controller)return error('temporarily_unavailable',503);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(!['GET','PUT'].includes(request.method))return new Response(null,{status:405,headers:{...headers,Allow:'GET, PUT, OPTIONS'}});
 const operation=request.method==='GET'?'read':'write';
 try{
  const limits=await controller.inspectObjectURL(request.url,operation),args={};
  if(operation==='read'){
   if(request.headers.has('Range')){args.range=parseRange(request.headers.get('Range'));if(limits.range&&(args.range.start<limits.range.start||args.range.end>limits.range.end))fail('forbidden',403);}else if(limits.range)args.range=limits.range;
   const ifVersion=request.headers.get('If-Match');if(ifVersion){if(limits.ifVersion&&ifVersion!==limits.ifVersion)fail('forbidden',403);args.ifVersion=ifVersion;}else if(limits.ifVersion)args.ifVersion=limits.ifVersion;
   if(request.headers.has('If-None-Match'))fail('invalid_headers');
  }else{
   if(request.headers.has('Content-Encoding')||request.headers.has('Range'))fail('invalid_headers');
   const contentType=request.headers.get('Content-Type')??'application/octet-stream';if(contentType!==limits.contentType)fail('content_type_mismatch');
   if(limits.condition?.absent===true){if(request.headers.get('If-None-Match')!=='*'||request.headers.has('If-Match'))fail('precondition_required',428);}else if(typeof limits.condition?.version==='string'){if(request.headers.get('If-Match')!==limits.condition.version||request.headers.has('If-None-Match'))fail('precondition_required',428);}else fail('precondition_required',428);
   args.dataBase64=base64(await readBytes(request,limits.size));args.contentType=contentType;
  }
  const result=await controller.objectURL(request.url,operation,args);
  if(result?.error)throw Object.assign(new Error(result.error.code),result.error);
  if(operation==='write')return new Response(JSON.stringify(result),{status:200,headers:{...headers,'Content-Type':'application/json'}});
  if(typeof result?.dataBase64!=='string'||result.dataBase64.length>1398104)fail('invalid_response',502);
  const bytes=Uint8Array.from(atob(result.dataBase64),char=>char.charCodeAt(0)),extra={'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="download"','Content-Length':String(bytes.byteLength)};
  if(bytes.byteLength>1048576||args.range&&(bytes.byteLength===0||bytes.byteLength>args.range.end-args.range.start+1))fail('invalid_response',502);
  if(typeof result.object?.version==='string'&&!/[\r\n]/.test(result.object.version))extra.ETag=result.object.version;
  if(typeof result.object?.contentType==='string'&&!/[\r\n]/.test(result.object.contentType))extra['X-Bindle-Content-Type']=result.object.contentType;
  if(args.range)extra['Content-Range']=`bytes ${args.range.start}-${args.range.start+bytes.byteLength-1}/*`;
  return new Response(bytes,{status:args.range?206:200,headers:{...headers,...extra}});
 }catch(cause){return error(cause.code??'temporarily_unavailable',cause.status??({unauthorized:401,forbidden:403,not_found:404,conflict:409,tx_conflict:409,indeterminate:409,quota_exceeded:429,rate_limited:429,temporarily_unavailable:503,storage_write_unavailable:503}[cause.code]??400),cause.retryAfter);}
}

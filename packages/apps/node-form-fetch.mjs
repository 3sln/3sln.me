import {lookup as nodeLookup} from 'node:dns/promises';
import {request as nodeRequest} from 'node:https';
import {formOrigins,formRequest,formResponseHeaders,formTransportError,publicAddress,transportLimits} from './form-fetch-policy.mjs';

/** DNS-pinned HTTPS public IPv4 only; never follows redirects or shares agents. */
export function createNodeFormFetch({allowedOrigins,lookup=nodeLookup,request=nodeRequest,...limits}={}){
 const origins=formOrigins(allowedOrigins),{timeoutMs,maxConcurrent}=transportLimits(limits);let active=0;
 return {async send(input){const policy=formRequest(input,origins);if(policy.signal?.aborted||active>=maxConcurrent)throw formTransportError();active++;
  try{return await new Promise((resolve,reject)=>{
   let req,res,done=false;const abort=()=>finish(formTransportError()),timer=setTimeout(abort,timeoutMs);
   function finish(error,value){if(done)return;done=true;clearTimeout(timer);policy.signal?.removeEventListener('abort',abort);if(error){res?.destroy();req?.destroy();reject(formTransportError());}else resolve(value);}
   policy.signal?.addEventListener('abort',abort,{once:true});
   Promise.resolve().then(()=>lookup(policy.url.hostname,{all:true,family:4,verbatim:true})).then(records=>{
    if(done)return;if(!Array.isArray(records)||!records.length||records.length>64||records.some(r=>r.family!==4||!publicAddress(r.address)||r.address.includes(':')))throw formTransportError();const selected=records[0].address;
    const pinned=(_host,opts,cb)=>{if(typeof opts==='function'){cb=opts;opts={};}if(opts?.all)cb(null,[{address:selected,family:4}]);else cb(null,selected,4);};
    req=request({protocol:'https:',hostname:policy.url.hostname,port:443,path:policy.url.pathname+policy.url.search,method:'POST',servername:policy.url.hostname,lookup:pinned,agent:false,rejectUnauthorized:true,maxHeaderSize:8192,headers:{...policy.headers,Host:policy.url.host,'Content-Length':String(policy.body.length)}},incoming=>{
     res=incoming;if(done){res.destroy();return;}try{
      const status=res.statusCode;if(!Number.isInteger(status)||status<200||status>599)throw formTransportError();const headers=formResponseHeaders(k=>res.headers[k]);
      if(status>=300&&status<400){finish(null,{status,headers,bytes:new Uint8Array()});res.destroy();return;}
      const length=res.headers['content-length'],encoding=res.headers['content-encoding'];if(encoding&&encoding.toLowerCase()!=='identity'||length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>policy.maxBytes))throw formTransportError();
      const chunks=[];let size=0;res.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>policy.maxBytes){finish(formTransportError());return;}chunks.push(Buffer.from(chunk));});res.once('error',()=>finish(formTransportError()));res.once('aborted',()=>finish(formTransportError()));res.once('end',()=>finish(null,{status,headers,bytes:new Uint8Array(Buffer.concat(chunks,size))}));
     }catch{finish(formTransportError());}
    });req.once('error',()=>finish(formTransportError()));req.end(policy.body);
   }).catch(()=>finish(formTransportError()));
  });}finally{active--;}
 }};
}

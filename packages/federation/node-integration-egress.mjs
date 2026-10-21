// Node discovery/describe transport: public IPv4, DNS pinned into HTTPS with the original TLS name.
import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {integrationEndpoint,DISCOVERY_LIMITS as L} from './resource-discovery.mjs';
import {publicAddress} from '../apps/form-fetch-policy.mjs';
export function createNodeIntegrationEgress({issuer,reserved=[],lookup=dnsLookup,request=httpsRequest,timeoutMs=L.timeoutMs,maxConcurrent=16}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>64)throw new TypeError('Invalid integration egress limits.');
 const refuse=()=>Object.assign(new Error('The integration could not be reached safely.'),{code:'egress_refused',status:502});let active=0;
 return {async send({url,headers={},body,maxBytes,signal}={}){
  const u=integrationEndpoint(url,{issuer,reserved});if(!u||typeof body!=='string'||new TextEncoder().encode(body).length>65536||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>L.responseBytes||signal?.aborted)throw refuse();
  if(active>=maxConcurrent)throw Object.assign(new Error('The provider is busy.'),{code:'egress_busy',status:503,retryAfter:1});active++;
  try{return await new Promise((resolve,reject)=>{
   let req,res,done=false;const timer=setTimeout(()=>finish(refuse()),timeoutMs),abort=()=>finish(refuse());signal?.addEventListener('abort',abort,{once:true});
   function finish(error,value){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){res?.destroy();req?.destroy();reject(refuse());}else resolve(value);}
   Promise.resolve().then(()=>lookup(u.hostname,{all:true,family:4,verbatim:true})).then(records=>{
    if(done)return;if(!Array.isArray(records)||!records.length||records.length>64||records.some(r=>r?.family!==4||typeof r.address!=='string'||r.address.includes(':')||!publicAddress(r.address)))throw refuse();const selected=records[0].address;
    const pinned=(_host,opts,cb)=>{if(typeof opts==='function'){cb=opts;opts={};}if(opts?.all)cb(null,[{address:selected,family:4}]);else cb(null,selected,4);};
    const bytes=new TextEncoder().encode(body);
    req=request({protocol:'https:',hostname:u.hostname,port:443,path:u.pathname,method:'POST',servername:u.hostname,lookup:pinned,agent:false,rejectUnauthorized:true,maxHeaderSize:8192,headers:{...headers,'Accept-Encoding':'identity',Host:u.host,'Content-Length':String(bytes.length)}},incoming=>{
     res=incoming;if(done){res.destroy();return;}try{
      const status=res.statusCode,contentType=String(res.headers['content-type']??'').slice(0,128),length=res.headers['content-length'],encoding=res.headers['content-encoding'];
      if(!Number.isInteger(status)||status<200||status>599)throw refuse();
      if(status>=300&&status<400){finish(null,{status,contentType:'',bytes:new Uint8Array()});res.destroy();return;}
      if(encoding&&encoding.toLowerCase()!=='identity'||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw refuse();
      const chunks=[];let size=0;res.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>maxBytes){finish(refuse());return;}chunks.push(new Uint8Array(chunk));});res.once('error',()=>finish(refuse()));res.once('aborted',()=>finish(refuse()));
      res.once('end',()=>{const out=new Uint8Array(size);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}finish(null,{status,contentType,bytes:out});});
     }catch{finish(refuse());}
    });req.once('error',()=>finish(refuse()));req.end(bytes);
   }).catch(()=>finish(refuse()));
  });}finally{active--;}
 }};
}

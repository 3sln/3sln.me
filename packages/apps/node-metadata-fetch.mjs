// Optional Node-only presentation-metadata egress. Disabled unless explicitly
// injected by the operator. IPv6 is deliberately unavailable until a reviewed
// global-address classifier is provided. Resolve A records only so dual-stack
// hosts remain usable; injected resolvers returning IPv6 fail closed.
import {lookup as nodeLookup} from 'node:dns/promises';
import {request as nodeRequest} from 'node:https';
import {isIP} from 'node:net';

function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
function positive(value,max,label){if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`Invalid metadata ${label}.`);return value;}
export function createNodeMetadataFetch({allowedOrigins,lookup=nodeLookup,request=nodeRequest,timeoutMs=1500,maxBytes=131072,maxConcurrent=4,maxRequestsPerMinute=30,maxRequestsPerDay=200,clock=()=>Date.now()}={}){
 if(!Array.isArray(allowedOrigins)||!allowedOrigins.length)throw new Error('Registered metadata origins are required.');
 const origins=new Set(allowedOrigins.map(value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.port&&u.port!=='443')throw new Error('Metadata origins must be HTTPS on port 443.');return u.origin;}));
 positive(timeoutMs,1500,'timeout');positive(maxBytes,131072,'body limit');positive(maxConcurrent,16,'concurrency');positive(maxRequestsPerMinute,600,'request rate');positive(maxRequestsPerDay,10000,'daily request rate');
 let active=0;let attempts=[];
 return async function publicFetch(value,options={}){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port&&u.port!=='443'||!origins.has(u.origin)||isIP(u.hostname.replace(/^\[|\]$/g,''))===6)throw new Error('Metadata URL is outside the registered public HTTPS policy.');
  if(options.method!==undefined&&options.method!=='GET')throw new Error('Metadata permits GET only.');
  const accept=new Headers(options.headers).get('Accept')??'application/manifest+json, application/json';
  if(!['text/html','application/manifest+json, application/json'].includes(accept))throw new Error('Unsupported metadata Accept header.');
  if(options.signal?.aborted)throw new Error('Metadata request aborted.');
  const now=clock();if(!Number.isFinite(now))throw new Error('Metadata clock unavailable.');
  attempts=attempts.filter(t=>t>now-86400000);if(active>=maxConcurrent||attempts.length>=maxRequestsPerDay||attempts.filter(t=>t>now-60000).length>=maxRequestsPerMinute)throw new Error('Metadata egress budget exhausted.');
  attempts.push(now);active++;
  try{return await new Promise((resolve,reject)=>{
   let req,res,done=false;const abort=()=>finish(new Error('Metadata request aborted.'));
   const timer=setTimeout(()=>finish(new Error('Metadata request timed out.')),timeoutMs);
   function finish(error,response){if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error){res?.destroy();req?.destroy();reject(error);}else resolve(response);}
   options.signal?.addEventListener('abort',abort,{once:true});
   Promise.resolve().then(()=>lookup(u.hostname,{all:true,family:4,verbatim:true})).then(records=>{
    if(done)return;
    if(!Array.isArray(records)||!records.length||records.length>64||records.some(r=>r.family!==4||!publicIPv4(r.address)))throw new Error('Metadata DNS must contain only globally routable IPv4 addresses; IPv6 is not supported.');
    const selected=records[0].address;
    const pinnedLookup=(_hostname,opts,callback)=>{if(typeof opts==='function'){callback=opts;opts={};}if(opts?.all)callback(null,[{address:selected,family:4}]);else callback(null,selected,4);};
    req=request({protocol:'https:',hostname:u.hostname,port:443,path:u.pathname,method:'GET',servername:u.hostname,agent:false,rejectUnauthorized:true,lookup:pinnedLookup,headers:{Host:u.host,Accept:accept,'Accept-Encoding':'identity'}},incoming=>{
     res=incoming;if(done){res.destroy();return;}
     const length=res.headers['content-length'],encoding=res.headers['content-encoding'];
     if(res.statusCode!==200||encoding&&encoding.toLowerCase()!=='identity'||length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>maxBytes)){finish(new Error('Metadata response rejected.'));return;}
     let size=0;const chunks=[];
     res.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>maxBytes){finish(new Error('Metadata response exceeds limits.'));return;}chunks.push(Buffer.from(chunk));});
     res.once('error',error=>finish(error));res.once('aborted',()=>finish(new Error('Metadata response interrupted.')));
     res.once('end',()=>{if(done)return;try{const headers=new Headers();for(const key of ['content-type','content-length'])if(typeof res.headers[key]==='string')headers.set(key,res.headers[key]);finish(null,new Response(Buffer.concat(chunks,size),{status:200,headers}));}catch(error){finish(error);}});
    });
    req.once('error',error=>finish(error));req.end();
   }).catch(error=>finish(error));
  });}finally{active--;}
 };
}

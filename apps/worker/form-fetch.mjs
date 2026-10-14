import {formOrigins,formRequest,formResponseHeaders,formTransportError,publicAddress,transportLimits} from '../../packages/apps/form-fetch-policy.mjs';

/** Requires global_fetch_strictly_public and an explicit operator egress list.
 * DoH screening is NOT connection pinning: DNS can change before native fetch.
 * Only global public fetch is injected; never a VPC/service-binding fetch. */
export function createWorkerFormFetch({allowedOrigins,publicRouting=false,fetcher=globalThis.fetch,...limits}={}){
 if(publicRouting!==true)throw formTransportError();const origins=formOrigins(allowedOrigins),{timeoutMs,maxConcurrent}=transportLimits(limits);let active=0;
 return {async send(input){const policy=formRequest(input,origins);if(policy.signal?.aborted||active>=maxConcurrent)throw formTransportError();active++;
  const controller=new AbortController();let reader,timer;const abort=()=>controller.abort();policy.signal?.addEventListener('abort',abort,{once:true});
  async function read(response,max){reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let size=0;try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>max)throw formTransportError();chunks.push(result.value);}const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}return out;}catch(error){reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();reader=undefined;}}
  async function dns(type){const endpoint=new URL('https://cloudflare-dns.com/dns-query');endpoint.searchParams.set('name',policy.url.hostname);endpoint.searchParams.set('type',String(type));
   const response=await fetcher(endpoint.href,{method:'GET',headers:{Accept:'application/dns-json'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
   if(response.status!==200||!(response.headers.get('Content-Type')||'').toLowerCase().includes('application/dns-json')){await response.body?.cancel();throw formTransportError();}const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(response,16384)));
   if(result.Status!==0||result.TC===true||!Array.isArray(result.Question)||result.Question.length!==1||result.Question[0].name?.replace(/\.$/,'').toLowerCase()!==policy.url.hostname||result.Question[0].type!==type||result.Answer!==undefined&&!Array.isArray(result.Answer))throw formTransportError();
   const answers=result.Answer??[];if(answers.length>64||answers.some(r=>![5,type].includes(r.type)))throw formTransportError();const addresses=answers.filter(r=>r.type===type).map(r=>r.data);if(addresses.some(a=>!publicAddress(a)||type===1&&a.includes(':')||type===28&&!a.includes(':')))throw formTransportError();return addresses;
  }
  async function run(){
   // Sequential reads share one bounded reader, under the same total deadline.
   const a=await dns(1),aaaa=await dns(28);if(!a.length&&!aaaa.length||controller.signal.aborted)throw formTransportError();
   const response=await fetcher(policy.url.href,{method:'POST',headers:policy.headers,body:policy.body,credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
   if(!Number.isInteger(response.status)||response.status<200||response.status>599)throw formTransportError();const headers=formResponseHeaders(k=>response.headers.get(k));
   if(response.status>=300&&response.status<400){await response.body?.cancel();return {status:response.status,headers,bytes:new Uint8Array()};}
   const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');if(encoding&&encoding.toLowerCase()!=='identity'||length!==null&&(!/^\d+$/.test(length)||Number(length)>policy.maxBytes)){await response.body?.cancel();throw formTransportError();}
   return {status:response.status,headers,bytes:await read(response,policy.maxBytes)};
  }
  try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reader?.cancel().catch(()=>{});reject(formTransportError());},timeoutMs);controller.signal.addEventListener('abort',()=>reject(formTransportError()),{once:true});})]);}
  catch{abort();reader?.cancel().catch(()=>{});throw formTransportError();}
  finally{clearTimeout(timer);policy.signal?.removeEventListener('abort',abort);active--;}
 }};
}

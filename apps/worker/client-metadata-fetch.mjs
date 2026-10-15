import {publicAddress} from '../../packages/apps/form-fetch-policy.mjs';
import {metadataClientURL} from '../../packages/federation/client-metadata.mjs';

/** Workers egress for client-id-metadata.v1, on the same footing as the form postback port (./form-fetch.mjs): it
 * requires `global_fetch_strictly_public` (publicRouting) and screens the name over DoH, refusing any non-public A or
 * AAAA answer. DoH screening is NOT connection pinning: DNS can change before the native fetch, so the strictly-public
 * routing flag is the actual guard against private destinations. GET only, no credentials, no redirects (returned
 * as-is and refused by ClientDirectory), identity encoding. Body size, deadline, cache and budgets are enforced by
 * ClientDirectory. Only global public fetch is injected; never a VPC or service-binding fetch. */
export function createWorkerClientMetadataFetch({publicRouting=false,fetcher=globalThis.fetch}={}){
 if(publicRouting!==true)throw new TypeError('Client metadata egress requires global_fetch_strictly_public.');
 const refuse=()=>{throw Object.assign(new Error('The client metadata document could not be reached safely.'),{code:'invalid_client'});};
 async function dns(host,type,signal){
  const endpoint=new URL('https://cloudflare-dns.com/dns-query');endpoint.searchParams.set('name',host);endpoint.searchParams.set('type',String(type));
  const response=await fetcher(endpoint.href,{method:'GET',headers:{Accept:'application/dns-json'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal});
  if(response.status!==200||!(response.headers.get('Content-Type')||'').toLowerCase().includes('application/dns-json')){await response.body?.cancel();refuse();}
  const text=await response.text();if(text.length>16384)refuse();let result;try{result=JSON.parse(text);}catch{refuse();}
  if(result.Status!==0||result.TC===true||!Array.isArray(result.Question)||result.Question.length!==1||result.Question[0].name?.replace(/\.$/,'').toLowerCase()!==host||result.Question[0].type!==type||result.Answer!==undefined&&!Array.isArray(result.Answer))refuse();
  const answers=result.Answer??[];if(answers.length>64||answers.some(r=>![5,type].includes(r.type)))refuse();
  const addresses=answers.filter(r=>r.type===type).map(r=>r.data);if(addresses.some(a=>!publicAddress(a)||type===1&&a.includes(':')||type===28&&!a.includes(':')))refuse();return addresses;
 }
 return async function clientMetadataFetch(value,{signal}={}){
  const url=metadataClientURL(value);if(!url)refuse();
  const a=await dns(url.hostname,1,signal),aaaa=await dns(url.hostname,28,signal);if(!a.length&&!aaaa.length)refuse();
  return fetcher(url.href,{method:'GET',headers:{Accept:'application/json','Accept-Encoding':'identity'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal});
 };
}

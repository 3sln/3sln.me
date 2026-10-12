// Presentation metadata only. None of these fields establish an app's identity,
// contract conformance, permissions, redirect policy or trustworthiness.
import {parse,defaultTreeAdapter} from 'parse5';
const MAX_JSON=65536,MAX_HTML=131072,MAX_REQUESTS=6,TIMEOUT_MS=1500;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max?v.normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim():undefined;
const raster=new Set(['image/png','image/jpeg','image/webp','image/avif']);
export function metadataURL(value,base,allowedOrigins,{local=false}={}){
 if(typeof value!=='string'||value.length>2048)return undefined;
 let u;try{u=new URL(value,base);}catch{return undefined;}
 if(u.username||u.password||u.search||u.hash||!allowedOrigins.includes(u.origin)||u.protocol!=='https:'&&!(local&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))return undefined;
 return u.href;
}
export function metadataPolicy(client,{local=false}={}){
 const origins=[...new Set([...(client.origins??[]),...client.redirectUris.map(v=>new URL(v).origin)])];
 const appOrigin=origins[0];
 return {allowedOrigins:origins,appOrigin,local};
}
function icons(value,base,policy){return Array.isArray(value)?value.slice(0,8).flatMap(v=>{
 if(!object(v))return [];const src=metadataURL(v.src,base,policy.allowedOrigins,policy),type=text(v.type,32)?.toLowerCase();
 // Merely retain reviewed raster references. The UI never fetches them directly.
 if(!src||!raster.has(type)||/\.svg(?:$|\/)/i.test(new URL(src).pathname))return [];
 const sizes=text(v.sizes,100);return [{src,type,...sizes&&/^(?:\d{1,4}x\d{1,4})(?: \d{1,4}x\d{1,4})*$/.test(sizes)?{sizes}:{}}];
 }):[];}
export function parseWebAppManifest(value,url,policy){
 if(!object(value))return undefined;
 const name=text(value.name,100)||text(value.short_name,100),description=text(value.description,500),images=icons(value.icons,url,policy);
 if(!name&&!description&&!images.length)return undefined;
 return {...name?{name}:{},...description?{description}:{},icons:images,manifestURL:url,source:{kind:'web-app-manifest',url}};
}
export function parseBindleAppManifest(value,url,policy){
 if(!object(value)||!object(value.application))return undefined;
 const a=value.application,name=text(a.name,100)||text(a.short_name,100),description=text(a.description,500),images=icons(a.icons,url,policy),webAppManifest=metadataURL(a.web_manifest,url,policy.allowedOrigins,policy);
 return {...name?{name}:{},...description?{description}:{},icons:images,...webAppManifest?{webAppManifest}:{},source:{kind:'bindle-manifest',url}};
}
export function discoverWebAppManifest(html,url,policy){
 if(typeof html!=='string'||new TextEncoder().encode(html).byteLength>MAX_HTML)return undefined;
 let elements=0;const boundedParent=parent=>{let depth=0;for(let n=parent;n;n=defaultTreeAdapter.getParentNode(n))if(++depth>128)throw new Error('Metadata HTML depth limit.');};
 const treeAdapter={...defaultTreeAdapter,createElement(...args){if(++elements>10000)throw new Error('Metadata HTML element limit.');return defaultTreeAdapter.createElement(...args);},appendChild(parent,node){boundedParent(parent);return defaultTreeAdapter.appendChild(parent,node);},insertBefore(parent,node,reference){boundedParent(parent);return defaultTreeAdapter.insertBefore(parent,node,reference);}};
 let document;try{document=parse(html,{scriptingEnabled:false,treeAdapter});}catch{return undefined;}let manifest,base=url;
 const stack=[document];let nodes=0;
 while(stack.length){const node=stack.pop();if(++nodes>10000)return undefined;
  if(node.tagName==='template'||node.tagName==='script'||node.tagName==='noscript')continue;
  if(node.tagName==='base'&&base===url){const href=node.attrs?.find(a=>a.name==='href')?.value;if(href!==undefined){const resolved=metadataURL(href,url,policy.allowedOrigins,policy);if(!resolved)return undefined;base=resolved;}}
  if(node.tagName==='link'&&node.namespaceURI==='http://www.w3.org/1999/xhtml'){
   const attrs=Object.fromEntries((node.attrs??[]).map(a=>[a.name,a.value]));
   if(attrs.rel?.toLowerCase().split(/\s+/).includes('manifest'))manifest=metadataURL(attrs.href,base,policy.allowedOrigins,policy);
  }
  if(manifest)return manifest;for(const child of [...node.childNodes??[]].reverse())stack.push(child);
 }return undefined;
}
export function validateAppMetadataConfig(client,{local=false}={}){
 const policy=metadataPolicy(client,{local});
 if(client.application!==undefined){if(!object(client.application)||Object.keys(client.application).some(k=>!['name','short_name','description','icons','web_manifest'].includes(k)))throw new Error('Invalid registered application metadata.');
  for(const [k,max]of [['name',100],['short_name',100],['description',500]])if(client.application[k]!==undefined&&(!text(client.application[k],max)||client.application[k].length>max))throw new Error('Invalid application label.');
  if(client.application.icons!==undefined&&(!Array.isArray(client.application.icons)||client.application.icons.length>8||icons(client.application.icons,policy.appOrigin+'/',policy).length!==client.application.icons.length))throw new Error('Use registered-origin raster icon references.');
  if(client.application.web_manifest!==undefined&&!metadataURL(client.application.web_manifest,policy.appOrigin+'/',policy.allowedOrigins,policy))throw new Error('Use a registered-origin public manifest URL.');
 }
 if(client.metadataSources!==undefined){if(!object(client.metadataSources)||Object.keys(client.metadataSources).some(k=>!['bindleManifest','webAppManifest','indexPage','authorizationPage'].includes(k)))throw new Error('Invalid metadata sources.');for(const v of Object.values(client.metadataSources))if(!metadataURL(v,undefined,policy.allowedOrigins,policy))throw new Error('Use registered-origin public metadata sources.');}
 return policy;
}
async function readBounded(response,limit){
 const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('Metadata response exceeds limits.');
 if(!response.body)return '';const reader=response.body.getReader();let length=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw new Error('Metadata response exceeds limits.');chunks.push(value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{await reader.cancel().catch(()=>{});}
}
/** publicFetch is an operator-injected verified egress port. It MUST enforce DNS/
 * resolved IP/port policy at the actual network hop, reject redirects, omit all
 * credentials, enforce outbound rate/cost budgets, and honor AbortSignal.
 * No global fetch fallback is permitted; a URL allowlist is not SSRF protection.
 */
export async function collectAppMetadata(client,{publicFetch,local=false}={}){
 const policy=validateAppMetadataConfig(client,{local}),declared=parseBindleAppManifest({application:client.application},policy.appOrigin+'/',policy);
 const fallback={name:text(client.name,100)||client.id,appOrigin:policy.appOrigin,icons:[],source:{kind:'registered'},discovery:'fallback'};
 const supplied=declared&&{...fallback,...declared,name:declared.name||fallback.name,source:{kind:'registered'},discovery:'declared'};
 if(!publicFetch)return supplied?omitPointer(supplied):{...fallback,discovery:'unavailable'};
 let requests=0;
 const get=async(url,html=false)=>{
  if(!url||requests++>=MAX_REQUESTS)return undefined;const abort=new AbortController();let response,timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();if(response?.body)response.body.cancel().catch(()=>{});reject(new Error('Metadata timeout.'));},TIMEOUT_MS);});
   return await Promise.race([timeout,(async()=>{
    response=await publicFetch(url,{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:html?'text/html':'application/manifest+json, application/json'},signal:abort.signal});
    if(!response||response.status!==200||response.redirected||response.url&&response.url!==url)throw new Error('Metadata unavailable.');
    const type=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();if(html?type!=='text/html':!['application/json','application/manifest+json'].includes(type))throw new Error('Unsupported metadata type.');
    const body=await readBounded(response,html?MAX_HTML:MAX_JSON);return html?body:JSON.parse(body);
   })()]);
  }catch{return undefined;}finally{clearTimeout(timer);abort.abort();if(response?.body&&!response.body.locked)response.body.cancel().catch(()=>{});}
 };
 const sources=client.metadataSources??{},resolve=v=>metadataURL(v,policy.appOrigin+'/',policy.allowedOrigins,policy);
 const bindleURL=resolve(sources.bindleManifest),bindle=bindleURL&&parseBindleAppManifest(await get(bindleURL),bindleURL,policy);
 let webURL=resolve(declared?.webAppManifest||bindle?.webAppManifest||sources.webAppManifest),web=webURL&&parseWebAppManifest(await get(webURL),webURL,policy);
 if(!web){for(const page of [sources.indexPage,sources.authorizationPage]){const pageURL=resolve(page);if(!pageURL)continue;const html=await get(pageURL,true);webURL=discoverWebAppManifest(html,pageURL,policy);if(webURL){web=parseWebAppManifest(await get(webURL),webURL,policy);if(web)break;}}}
 const resolved=bindle||web;
 if(!resolved)return supplied?omitPointer(supplied):fallback;
 const result={...fallback,...web,...bindle,...declared,name:declared?.name||bindle?.name||web?.name||fallback.name,icons:declared?.icons?.length?declared.icons:bindle?.icons?.length?bindle.icons:web?.icons??[],source:declared?.name?{kind:'registered'}:bindle?.name?bindle.source:web?.source??resolved.source,discovery:'resolved'};
 return omitPointer(result);
}
function omitPointer(value){const {webAppManifest,...rest}=value;return rest;}

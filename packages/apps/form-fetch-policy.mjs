// This is a transport boundary, not caller authorization. The broker separately
// binds an authenticated message, connection, form and one-shot operation.
export const FORM_REQUEST_BYTES=16384,FORM_RESPONSE_BYTES=131072;
export function formTransportError(){return Object.assign(new Error('The form destination could not be reached safely.'),{code:'form_transport_unavailable',status:502});}
export function publicAddress(address){
 if(typeof address!=='string')return false;
 if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){
  const parts=address.split('.');if(parts.some(x=>String(Number(x))!==x||Number(x)>255))return false;
  const [a,b,c]=parts.map(Number);
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
 }
 // Deliberately conservative IPv6 global unicast subset. Reject translation,
 // special-purpose, documentation and transition prefixes, including 6to4.
 try{if(address.includes('%'))return false;const u=new URL('https://['+address+']/');const raw=u.hostname.slice(1,-1),[left,right]=raw.split('::'),a=left?left.split(':'):[],b=right?right.split(':'):[];
  const groups=right===undefined?a:[...a,...Array(8-a.length-b.length).fill('0'),...b];if(groups.length!==8)return false;
  const [first,second]=groups.map(v=>parseInt(v,16));return first>=0x2000&&first<=0x3fff&&first!==0x2002&&first!==0x3fff&&!(first===0x2001&&(second<=0x01ff||second===0x0db8));
 }catch{return false;}
}
export function formOrigins(values){
 if(!Array.isArray(values)||!values.length||values.length>256)throw formTransportError();
 return new Set(values.map(value=>{if(typeof value!=='string')throw formTransportError();let u;try{u=new URL(value);}catch{throw formTransportError();}
  if(u.protocol!=='https:'||u.origin!==value||u.pathname!=='/'||u.port||u.username||u.password||u.search||u.hash||!publicHostname(u.hostname))throw formTransportError();return u.origin;}));
}
/** Explicit egress approval is separate from ordinary app registration. */
export function configuredFormOrigins(config={}){
 const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{throw formTransportError();}};
 const approved=parse(config.FORM_POSTBACK_ORIGINS??[]);if(!Array.isArray(approved)||approved.length>256||new Set(approved).size!==approved.length)throw formTransportError();if(!approved.length)return [];
 const origins=formOrigins(approved),clients=parse(config.FEDERATION_CLIENTS??[]);if(!Array.isArray(clients)||clients.length>100)throw formTransportError();const registered=new Set();
 for(const client of clients){let u;try{if(typeof client?.origin!=='string')throw 0;u=new URL(client.origin);}catch{throw formTransportError();}if(!['https:','http:'].includes(u.protocol)||u.origin!==client.origin||u.username||u.password||u.hash||u.search||u.pathname!=='/'||u.protocol==='http:'&&!(config.LOCAL_DEVELOPMENT==='true'&&u.hostname==='localhost'))throw formTransportError();registered.add(u.origin);}
 return [...origins].filter(origin=>registered.has(origin));
}
function publicHostname(host){return host.length<=253&&host.includes('.')&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&!/^\d+(?:\.\d+)*$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host);}
export function formRequest(input,origins){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['url','method','headers','body','maxResponseBytes','signal'].includes(k))||typeof input.url!=='string'||input.url.length>4096||input.method!=='POST'||!(input.body instanceof Uint8Array)||input.body.length>FORM_REQUEST_BYTES)throw formTransportError();
 let u;try{u=new URL(input.url);}catch{throw formTransportError();}if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port||!origins.has(u.origin))throw formTransportError();
 if(input.signal!==undefined&&!(input.signal instanceof AbortSignal))throw formTransportError();
 let h;try{h=new Headers(input.headers);}catch{throw formTransportError();}if([...h.keys()].some(k=>!['content-type','idempotency-key'].includes(k))||h.get('content-type')!=='application/x-www-form-urlencoded'||!/^[-A-Za-z0-9_]{16,128}$/.test(h.get('idempotency-key')||''))throw formTransportError();
 const maxBytes=input.maxResponseBytes??FORM_RESPONSE_BYTES;if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>FORM_RESPONSE_BYTES)throw formTransportError();
 return {url:u,body:new Uint8Array(input.body),headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':h.get('idempotency-key'),Accept:'text/html, text/plain, application/vnd.bindle.submission-status+json','Accept-Encoding':'identity'},maxBytes,signal:input.signal};
}
export function formResponseHeaders(get){const headers={};for(const [wire,name,max]of [['content-type','contentType',128],['location','location',2048],['bindle-target','bindleTarget',32]]){const value=get(wire);if(value!==null&&value!==undefined){if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw formTransportError();headers[name]=value;}}return headers;}
export function transportLimits({timeoutMs=5000,maxConcurrent=4}={}){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>16)throw formTransportError();return {timeoutMs,maxConcurrent};}

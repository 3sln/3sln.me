export class StorageError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function approvedEndpoint(value, allowedHosts = []) {
  let url; try { url = new URL(value); } catch { throw new StorageError('invalid_endpoint','Enter a valid HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new StorageError('invalid_endpoint','Endpoint must use HTTPS without credentials, custom ports, query, or fragment.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || /\.(local|internal|localhost)$/.test(host)) throw new StorageError('blocked_endpoint','Private and IP endpoints are not allowed.');
  // Custom services require an operator-approved hostname. No wildcard supplied by users.
  const trusted = allowedHosts.includes(host) || /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) || /^[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) || /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(host) || /^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(host);
  if (!trusted) throw new StorageError('endpoint_approval_required','This custom service requires operator approval before credentials can be sent.');
  return url;
}
export function objectKey(key) {
  if (typeof key !== 'string' || !key.length || new TextEncoder().encode(key).length > 1024 || /[\x00-\x1f\x7f]/.test(key) || key.split('/').some(p => !p || p === '.' || p === '..') || /%2e|%2f|%5c/i.test(key) || key.includes('\\')) throw new StorageError('invalid_key','Object key is invalid or contains a traversal sequence.');
  return key;
}
export function endpointKey(base, prefix, key) {
  objectKey(key);
  const path = [prefix, key].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
  return new URL(base.toString().replace(/\/?$/,'/') + path);
}
export async function checkedFetch(fetcher, url, options = {}) {
  let response;try{response = await fetcher(url, {...options, redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new StorageError('upstream_unavailable','Storage provider is unavailable.',502);}
  if (!response.ok) {const code=({401:'reauthorization_required',403:'forbidden',404:'not_found',409:'conflict',412:'conflict',429:'rate_limited'})[response.status]||'upstream_error';await response.body?.cancel();throw new StorageError(code,'Storage provider rejected the request.',response.status===412?409:response.status>=500?502:response.status);}
  return response;
}
export async function boundedBody(response, limit = 1048576) {
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader();const chunks=[];let length=0;
  try { while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new StorageError('size_limit','Provider response exceeded the byte limit.');}chunks.push(value);} }finally{reader.releaseLock();}
  const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
export function rangeHeaders(range){if(!range)return {};if(!Number.isSafeInteger(range.start)||range.start<0||!Number.isSafeInteger(range.end)||range.end<range.start||range.end-range.start>=1048576)throw new StorageError('invalid_range','Range is invalid.');return {Range:`bytes=${range.start}-${range.end}`};}
export async function readResult(response,{range,ifVersion}={}){const version=response.headers.get('etag');if(ifVersion&&version!==ifVersion)throw new StorageError('conflict','Object version changed.',409);if(range&&(response.status!==206||!response.headers.get('content-range')?.startsWith(`bytes ${range.start}-`)))throw new StorageError('range_unavailable','Provider did not honor the requested range.');const bytes=await boundedBody(response,range?range.end-range.start+1:1048576);return {bytes,version,contentType:response.headers.get('content-type')||'application/octet-stream',size:bytes.byteLength};}
export async function jsonBody(response){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBody(response)));}catch(error){if(error instanceof StorageError)throw error;throw new StorageError('invalid_response','Provider returned invalid JSON.',502);}}
export function listLimit(limit=100){if(!Number.isInteger(limit)||limit<1||limit>1000)throw new StorageError('invalid_args','List limit is invalid.');return limit;}
export function scopePrefix(root,prefix=''){if(root)objectKey(root);if(prefix)objectKey(prefix);return `${root?root+'/':''}${prefix}`;}
export function localKey(full,root=''){const boundary=root?root+'/':'';if(typeof full!=='string'||!full.startsWith(boundary)||full===boundary)throw new StorageError('namespace_violation','Provider returned an object outside the selected namespace.',502);return objectKey(full.slice(boundary.length));}
export const sorted = objects => objects.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
export function cursorEncode(scope,token){return btoa(unescape(encodeURIComponent(JSON.stringify({scope,token})))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
export function cursorDecode(cursor,scope){if(!cursor)return undefined;try{if(typeof cursor!=='string'||cursor.length>16384||!/^[\w-]+$/.test(cursor))throw 0;const data=JSON.parse(decodeURIComponent(escape(atob(cursor.replaceAll('-','+').replaceAll('_','/')))));if(data.scope!==scope||typeof data.token!=='string'||data.token.length>12000)throw 0;return data.token;}catch{throw new StorageError('invalid_cursor','Cursor does not belong to this resource and prefix.');}}

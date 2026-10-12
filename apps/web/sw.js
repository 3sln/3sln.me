/* Generated from the final public build. Account responses and credentials never enter Cache Storage. */
const BUILD=/*__3SLN_PUBLIC_BUILD__*/null;
if(!BUILD)throw new Error('Build the public application before registering its service worker.');
const CACHE=`3sln-public-shell:${BUILD.buildId}:${BUILD.cacheVersion}`;
const ASSETS=new Map(BUILD.assets.map(asset=>[asset.url,asset.sha256]));
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
function publicResponse(response){return response.ok&&!response.redirected&&!response.headers.has('set-cookie')&&!/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control')||'');}
async function immutableResponse(url){
  const response=await fetch(new Request(new URL(url,self.location.origin),{credentials:'omit',cache:'no-store',redirect:'error'}));
  if(!publicResponse(response))throw new Error('A public shell dependency could not be cached.');
  if(await digest(await response.clone().arrayBuffer())!==ASSETS.get(url))throw new Error('A public shell dependency does not match the build manifest.');
  return response;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  // Fetch and authenticate the complete generation before publishing any of it.
  // A missing or replaced dependency rejects install, leaving the old worker active.
  const responses=await Promise.all([...ASSETS.keys()].map(async url=>[url,await immutableResponse(url)]));
  const existed=(await caches.keys()).includes(CACHE),cache=await caches.open(CACHE);
  try{for(const [url,response]of responses)await cache.put(url,response);}catch(error){if(!existed)await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil(Promise.resolve()));
// Deliberately use the browser's normal waiting-worker lifecycle. Existing tabs
// keep their controller and cache; no skipWaiting, clients.claim, or old-generation
// deletion can strand a running tab that still needs one of its old module URLs.
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.search)return;
  if(request.mode==='navigate'&&url.pathname==='/'){
    // Live HTML may contain nonce-bearing CSP or request-specific public bootstrap.
    // Never cache that response. The fallback is this build's static public document.
    event.respondWith(fetch(request).catch(async()=>{
      const cache=await caches.open(CACHE);return await cache.match(BUILD.offlineDocument)??Response.error();
    }));return;
  }
  if(!ASSETS.has(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),stored=await cache.match(url.pathname);if(stored)return stored;
    // Only exact build-manifest URLs can be populated after installation.
    try{const response=await immutableResponse(url.pathname);await cache.put(url.pathname,response.clone());return response;}catch{return Response.error();}
  })());
});

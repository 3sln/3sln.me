// Optional partitioned service worker for the embed origin (embed-islands §3.3, EIR-2, EIR-16). Served at
// /embed/sw.js with `Service-Worker-Allowed: /embed`. Hashed assets cache-first; the shell network-first with a
// cached fallback only on a network error while offline and only when younger than 24 hours. The embed API is
// never intercepted or stored. One cache per build generation; no skipWaiting or clients.claim. Only content-hashed
// asset names are served cache-first, so an unhashed (development) path can never pin old island code (IMPL-6).
// GENERATION must be derived from the build (slice I8).
const GENERATION='bindle-embed-1',SHELL_MAX_AGE=86400000,HASHED=/\.[0-9a-f]{8,}\.(?:m?js|css)$/;
// `private` only excludes shared caches; this per-partition cache is private, so the shell (`private, max-age=300`) is storable.
const storable=response=>response.ok&&response.type==='basic'&&!response.headers.has('Set-Cookie')&&!/no-store/i.test(response.headers.get('Cache-Control')??'');
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('bindle-embed-')&&name!==GENERATION)await caches.delete(name);
  await self.registration.navigationPreload?.enable().catch(()=>{});
})()));
async function cacheFirst(request){
  const cache=await caches.open(GENERATION),hit=await cache.match(request);if(hit)return hit;
  const response=await fetch(request);if(storable(response))await cache.put(request,response.clone());return response;
}
async function shell(event){
  const cache=await caches.open(GENERATION);
  try{
    const response=(await event.preloadResponse)??await fetch(event.request);
    if(storable(response)){const headers=new Headers(response.headers);headers.set('X-Bindle-Cached-At',String(Date.now()));await cache.put(event.request,new Response(await response.clone().blob(),{status:response.status,headers}));}
    return response;
  }catch(error){
    const cached=navigator.onLine===false?await cache.match(event.request):null,at=Number(cached?.headers.get('X-Bindle-Cached-At'));
    if(cached&&Date.now()-at<SHELL_MAX_AGE)return cached;throw error;
  }
}
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/embed/api/'))return;
  if(url.pathname.startsWith('/embed/assets/')&&HASHED.test(url.pathname))event.respondWith(cacheFirst(event.request));
  else if(url.pathname==='/embed'&&event.request.mode==='navigate')event.respondWith(shell(event));
});

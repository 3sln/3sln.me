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
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  if(request.mode==='navigate'&&(url.pathname==='/console'||url.pathname==='/'&&[...url.searchParams.keys()].every(key=>['lang','signin','signup','return_to'].includes(key)))){
    // Live HTML may contain nonce-bearing CSP or request-specific public bootstrap.
    // Never cache that response. The fallback is this build's static public document.
    event.respondWith(fetch(request).catch(async()=>{
      const cache=await caches.open(CACHE);return await cache.match(url.pathname==='/console'||['signin','signup','return_to'].some(key=>url.searchParams.has(key))?BUILD.offlineDocument:BUILD.offlineLandings[url.searchParams.getAll('lang').length===1&&url.searchParams.get('lang')==='es'?'es':'en'])??Response.error();
    }));return;
  }
  if(url.search||!ASSETS.has(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),stored=await cache.match(url.pathname);if(stored)return stored;
    // Only exact build-manifest URLs can be populated after installation.
    try{const response=await immutableResponse(url.pathname);await cache.put(url.pathname,response.clone());return response;}catch{return Response.error();}
  })());
});

self.addEventListener('message',event=>{if(event.data?.type==='bindle-setup-capabilities')event.ports?.[0]?.postMessage({type:'bindle-setup-capabilities',version:1});});
self.addEventListener('push',event=>event.waitUntil((async()=>{let payload;try{if(!event.data||event.data.text().length>4096)return;payload=event.data.json();}catch{return;}if(payload?.type==='bindle-message'){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;if(!uuid.test(payload.messageId))return;
 const preview=typeof payload.sourceDigest==='string'&&/^[A-Za-z0-9_-]{43}$/.test(payload.sourceDigest),language=(payload.locale??self.navigator?.language??'en').split('-')[0],generic=BUILD.messageNotifications?.[language]??BUILD.messageNotifications?.en??{title:'New message',body:'You have an unread message.'};
 let title=generic.title,body=generic.body;const actions=[];
 if(preview){if(typeof payload.title==='string'&&Array.from(payload.title).length<=500)title=payload.title;if(typeof payload.body==='string'&&Array.from(payload.body).length<=800)body=payload.body;
  if(payload.sender&&typeof payload.sender.name==='string'&&Array.from(payload.sender.name).length<=100&&typeof payload.sender.origin==='string')try{const origin=new URL(payload.sender.origin);if(origin.protocol==='https:'&&origin.origin===payload.sender.origin)title='\u2068'+payload.sender.name+'\u2069 (\u2066'+origin.origin+'\u2069)';}catch{}
  for(const action of Array.isArray(payload.actions)?payload.actions.slice(0,2):[])if(typeof action.action==='string'&&/^(?:form:[0-9]{1,2}:[0-9]{1,2}|link:[0-9]{1,3})$/.test(action.action)&&typeof action.title==='string'&&Array.from(action.title).length<=80)actions.push({action:action.action,title:action.title});
 }
 await self.registration.showNotification(title,{body,tag:'bindle-message:'+payload.messageId,actions,data:{type:'bindle-message',messageId:payload.messageId,...preview?{sourceDigest:payload.sourceDigest}:{},actions:actions.map(action=>action.action)}});return;
}if(event.data.text().length>2048||payload?.type!=='bindle-setup-challenge'||typeof payload.owner!=='string'||typeof payload.proof!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(payload.proof)||!payload.proof.startsWith(payload.owner+'.'))return;const notice=BUILD.setupNotifications?.[payload.locale]??BUILD.setupNotifications?.en??{title:'Confirm account notifications',body:'Notifications are working. Return to account setup to continue.'};await self.registration.showNotification(notice.title,{body:notice.body,tag:'bindle-account-setup',data:{type:'bindle-setup-challenge'}});for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){const url=new URL(client.url);if(url.origin===self.location.origin&&url.pathname==='/recovery/setup')client.postMessage({type:'bindle-setup-challenge',owner:payload.owner,proof:payload.proof});}})()));
self.addEventListener('notificationclick',event=>{if(event.notification.data?.type==='bindle-message'){const data=event.notification.data;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.messageId))return;event.notification.close();event.waitUntil((async()=>{const url=new URL('/console',self.location.origin);url.searchParams.set('message',data.messageId);if(event.action&&Array.isArray(data.actions)&&data.actions.includes(event.action))url.searchParams.set('action',event.action);if(data.sourceDigest)url.searchParams.set('digest',data.sourceDigest);for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){const current=new URL(client.url);if(current.origin===self.location.origin&&current.pathname==='/console'){const navigated=await client.navigate(url.href);return (navigated??client).focus();}}return self.clients.openWindow(url.href);})());return;}if(event.notification.data?.type!=='bindle-setup-challenge')return;event.notification.close();event.waitUntil((async()=>{for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){const url=new URL(client.url);if(url.origin===self.location.origin&&url.pathname==='/recovery/setup')return client.focus();}return self.clients.openWindow('/recovery/setup');})());});

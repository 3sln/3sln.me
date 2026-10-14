import {signupCapacityLimits} from '../core/abuse-policy.mjs';
const memo=new WeakMap(),ttl=60000;
const valid=value=>value&&typeof value.globalAvailable==='boolean'&&typeof value.freeAvailable==='boolean';
export async function cachedSignupCapacity(env,execution){
 const limits=signupCapacityLimits(env),identity=env.SIGNUP_STATUS_CACHE_KEY??env.ABUSE;if(!identity||typeof identity!=='object')throw Error('Capacity unavailable');
 let entries=memo.get(identity);if(!entries){entries=new Map();memo.set(identity,entries);}const key=env.APP_ORIGIN+'|'+limits.limit+'|'+limits.freeLimit,now=Date.now(),previous=entries.get(key);if(previous&&previous.until>now)return previous.promise;
 if(entries.size>=4)entries.delete(entries.keys().next().value);
 const entry={until:now+ttl};entry.promise=(async()=>{const cache=globalThis.caches?.default,request=new Request(new URL(`/__internal/signup-capacity-v2/${limits.limit}/${limits.freeLimit}`,env.APP_ORIGIN));
  if(cache){try{const hit=await cache.match(request);if(hit){const snapshot=await hit.json();if(valid(snapshot.value)&&Number.isSafeInteger(snapshot.until)&&snapshot.until>now&&snapshot.until<=now+ttl){entry.until=snapshot.until;return {...snapshot.value,cacheUntil:entry.until};}}}catch{}}
  const value=await env.ABUSE.signupStatus('signup:lifetime-admission',limits);if(!valid(value))throw Error('Capacity unavailable');
  if(cache){const write=cache.put(request,new Response(JSON.stringify({value,until:entry.until}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=60'}})).catch(()=>{});if(execution?.waitUntil)execution.waitUntil(write);else await write;}
  return {...value,cacheUntil:entry.until};
 })();entries.set(key,entry);return entry.promise;
}

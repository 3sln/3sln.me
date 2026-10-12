// Durable Object values are bounded. Large RPC journal outcomes belong in the
// injected blob resource; the transaction stores only an immutable digest ref.
export function offloadMetadata(storage,blobs,prefix='metadata'){
 const hydrate=async value=>{if(!value?.__blobValue)return value;const object=await blobs.get(value.__blobValue);if(!object)throw new Error('Stored outcome is temporarily unavailable');return object.json();};
 const encode=async value=>{const text=JSON.stringify(value);if(new TextEncoder().encode(text).byteLength<=65536)return value;const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');const ref=`${prefix}/${digest}`;await blobs.put(ref,text);return {__blobValue:ref};};
 const adapt=native=>({get:async key=>hydrate(await native.get(key)),put:async(key,value)=>native.put(key,await encode(value)),delete:key=>native.delete(key),list:async options=>new Map(await Promise.all([...await native.list(options)].map(async([key,value])=>[key,await hydrate(value)])))});
 return {...adapt(storage),transaction:operation=>storage.transaction(native=>operation(adapt(native)))};
}

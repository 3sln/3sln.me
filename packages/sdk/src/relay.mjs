// Same-origin callback relay primitives (design §6.2, decision D7), shared by the
// waiting controller and the callback page. No DOM, storage or network.
export const relayParameters=Object.freeze(['code','state','iss','error','result']);
const encode64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

// The channel name is derived from the secret state, so unrelated tabs and
// earlier transactions never share a channel. It is same-origin by construction.
export async function callbackChannelName(state,crypto=globalThis.crypto){
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(state)));
  return 'bindle-callback:'+encode64(digest).slice(0,16);
}

// Exact-shape validation of a relayed message. Anything else is dropped silently.
export function parseRelayMessage(data){
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.getPrototypeOf(data)!==Object.prototype)return null;
  const keys=Object.keys(data);
  if(data.v!==1||data.type!=='bindle-callback'||keys.some(key=>!['v','type',...relayParameters].includes(key)))return null;
  for(const key of relayParameters)if(data[key]!==undefined&&(typeof data[key]!=='string'||!data[key]||data[key].length>2048))return null;
  if(typeof data.state!=='string')return null;
  const kinds=['code','error','result'].filter(key=>data[key]!==undefined);
  return kinds.length===1?data:null;
}

// Rebuilds the callback URL the provider redirected to, from validated parts.
export function relayCallbackUrl(redirectUri,message){
  const url=new URL(redirectUri);
  for(const key of relayParameters)if(message[key]!==undefined)url.searchParams.set(key,message[key]);
  return url.href;
}

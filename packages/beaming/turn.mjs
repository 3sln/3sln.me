import {BeamError} from './index.mjs';
// Provider credentials are bearer secrets. Never log responses or persisted SDP.
// API: https://developers.cloudflare.com/realtime/turn/generate-credentials/
export class CloudflareTurnAdapter {
 constructor({keyId,apiToken,fetch:request=globalThis.fetch}){Object.assign(this,{keyId,apiToken,request});}
 async issue({ttl=300}={}){
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(this.keyId||'')||!this.apiToken||!Number.isSafeInteger(ttl)||ttl<1||ttl>300)throw new BeamError('beam_turn_unconfigured','TURN is unavailable.',503);
 let response;try{response=await this.request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`,{method:'POST',headers:{Authorization:`Bearer ${this.apiToken}`,'Content-Type':'application/json'},body:JSON.stringify({ttl}),signal:AbortSignal.timeout(10000)});}catch{throw new BeamError('beam_turn_unavailable','TURN credential issuance failed.',503);}
 if(!response.ok)throw new BeamError('beam_turn_unavailable','TURN credential issuance failed.',503);
 let payload;try{payload=await response.json();}catch{throw new BeamError('beam_turn_invalid','TURN returned invalid credentials.',503);}
 if(!Array.isArray(payload.iceServers)||payload.iceServers.length>8||!payload.iceServers.length)throw new BeamError('beam_turn_invalid','TURN returned invalid credentials.',503);
 const iceServers=payload.iceServers.map(s=>{const urls=Array.isArray(s.urls)?s.urls:[s.urls];if(urls.length>8||urls.some(u=>typeof u!=='string'||!/^turns?:turn\.cloudflare\.com:\d+(\?transport=(tcp|udp))?$/.test(u)&&!/^stun:stun\.cloudflare\.com:\d+$/.test(u))||urls.some(u=>u.startsWith('turn'))&&(typeof s.username!=='string'||s.username.length>512||typeof s.credential!=='string'||s.credential.length>512))throw new BeamError('beam_turn_invalid','TURN returned invalid credentials.',503);return {urls,...s.username?{username:s.username}:{},...s.credential?{credential:s.credential}:{}};});return {iceServers,expiresIn:ttl};
 }
 async revoke(username){if(typeof username!=='string'||!username||username.length>512)throw new BeamError('beam_turn_invalid','Invalid TURN credential.');const response=await this.request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.keyId)}/credentials/${encodeURIComponent(username)}/revoke`,{method:'POST',headers:{Authorization:`Bearer ${this.apiToken}`},signal:AbortSignal.timeout(10000)});if(response.status!==204)throw new BeamError('beam_turn_unavailable','TURN credential revocation failed.',503);}
}

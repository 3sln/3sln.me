// Portable policy: the runtime supplies trusted network identity and an atomic
// window resource. No platform header, database or Cloudflare binding lives here.
const positive=(value,fallback)=>{value=value===undefined?fallback:value;if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))throw new TypeError('Invalid signup limit');const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new TypeError('Invalid signup limit');return n;};
export function signupCapacityLimits(config={}){const limit=positive(config.SIGNUP_MAX_ADMISSIONS,100000),freeLimit=positive(config.SIGNUP_FREE_MAX_ADMISSIONS,Math.min(10000,limit));if(freeLimit>limit)throw new TypeError('Invalid signup limit');return {limit,freeLimit};}
export function abuseWindows({operation,ipHash,subnetHash,handleHash,regionHash,signupLimits={},phase,signupKind='free'}){
 if(operation==='signup'&&phase==='attempt')return [{key:`signup:attempt:${ipHash}`,windowMs:60000,limit:5},{key:`signup:attempt-network:${subnetHash}`,windowMs:3600000,limit:100}];
 if(operation==='device-poll')return [{key:`device-poll:burst:${ipHash}`,windowMs:60000,limit:30},{key:`device-poll:ip:${ipHash}`,windowMs:600000,limit:120}];
 const windows=[{key:`${operation}:burst:${ipHash}`,windowMs:60000,limit:operation==='signup'?3:10}];
 if(operation==='signup'){
  const setting=(name,fallback)=>positive(signupLimits[name],fallback),capacity=signupCapacityLimits(signupLimits);if(!['free','paid'].includes(signupKind))throw new TypeError('Invalid signup kind');
  return [{key:`signup:ip-cooldown:${ipHash}`,windowMs:setting('SIGNUP_IP_WINDOW_MS',10800000),limit:1},
   {key:`signup:ip:${ipHash}`,windowMs:86400000,limit:setting('SIGNUP_IP_DAILY_LIMIT',2)},
   {key:`signup:subnet:${subnetHash}`,windowMs:86400000,limit:setting('SIGNUP_SUBNET_DAILY_LIMIT',15)},
   {key:`signup:region-hour:${regionHash||'unknown'}`,windowMs:3600000,limit:setting('SIGNUP_REGION_HOURLY_LIMIT',5)},
   {key:`signup:region-day:${regionHash||'unknown'}`,windowMs:86400000,limit:setting('SIGNUP_REGION_DAILY_LIMIT',25)},
   {key:'signup:global-hour',windowMs:3600000,limit:setting('SIGNUP_GLOBAL_HOURLY_LIMIT',10)},
   {key:'signup:global',windowMs:86400000,limit:setting('SIGNUP_GLOBAL_DAILY_LIMIT',200)},
   // Preserve this durable key: this ceiling counts all admitted attempts,
   // including paid, deleted, pending and failed creations. It is not a live
   // free-account census and must never reset on plan changes or daily alarms.
   ...signupKind==='paid'?[{key:'signup:paid-hour',windowMs:3600000,limit:setting('SIGNUP_PAID_HOURLY_LIMIT',5)},{key:'signup:paid-day',windowMs:86400000,limit:setting('SIGNUP_PAID_DAILY_LIMIT',25)}]:[],
   {key:'signup:lifetime-admission',lifetime:true,limit:capacity.limit,signup:{kind:signupKind,freeLimit:capacity.freeLimit}}];
 }
 if(handleHash)windows.push({key:`${operation}:handle:${handleHash}`,windowMs:300000,limit:20});
 windows.push({key:`${operation}:ip:${ipHash}`,windowMs:3600000,limit:50});return windows;
}
export async function enforceAbusePolicy(resource,inputs){for(const window of abuseWindows(inputs))if(!await resource.consume(window))return false;return true;}

// Portable policy: the runtime supplies trusted network identity and an atomic
// window resource. No platform header, database or Cloudflare binding lives here.
export function abuseWindows({operation,ipHash,subnetHash,handleHash,phase}){
 if(operation==='signup'&&phase==='attempt')return [{key:`signup:attempt:${ipHash}`,windowMs:60000,limit:5},{key:`signup:attempt-network:${subnetHash}`,windowMs:3600000,limit:100}];
 if(operation==='device-poll')return [{key:`device-poll:burst:${ipHash}`,windowMs:60000,limit:30},{key:`device-poll:ip:${ipHash}`,windowMs:600000,limit:120}];
 const windows=[{key:`${operation}:burst:${ipHash}`,windowMs:60000,limit:operation==='signup'?3:10}];
 if(operation==='signup')return [...windows,{key:`signup:ip:${ipHash}`,windowMs:86400000,limit:3},{key:`signup:subnet:${subnetHash}`,windowMs:86400000,limit:15},{key:'signup:global',windowMs:86400000,limit:200}];
 if(handleHash)windows.push({key:`${operation}:handle:${handleHash}`,windowMs:300000,limit:20});
 windows.push({key:`${operation}:ip:${ipHash}`,windowMs:3600000,limit:50});return windows;
}
export async function enforceAbusePolicy(resource,inputs){for(const window of abuseWindows(inputs))if(!await resource.consume(window))return false;return true;}

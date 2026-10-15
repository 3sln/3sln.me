// Host administration routes (reference implementation, not Bindle protocol).
// Mounted inside the /api/ block after the identity context is built. All
// routes are same-origin POST; the console names its actor explicitly.
const bootCookieName=local=>local?'bindle_boot':'__Host-bindle_boot';
const bootCookie=(token,local,maxAge)=>`${bootCookieName(local)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local?'':'; Secure'}`;
function bootSession(request,local){for(const piece of (request.headers.get('Cookie')||'').split(';')){const [key,...rest]=piece.trim().split('=');if(key===bootCookieName(local)){const value=rest.join('=');return /^[A-Za-z0-9_-]{43}$/.test(value)?value:undefined;}}}
const BOOT={'/api/admin/boot/status':'bootStatus','/api/admin/boot/start':'bootStart','/api/admin/boot/complete':'bootComplete','/api/admin/boot/login/begin':'bootLoginBegin','/api/admin/boot/login':'bootLogin','/api/admin/boot/step-up':'bootStepUp','/api/admin/boot/logout':'bootLogout','/api/admin/boot/session':'bootSessionInfo','/api/admin/boot/end':'bootEnd'};
const OPERATIONS={'/api/admin/overview':'overview','/api/admin/catalog':'setCatalog','/api/admin/reservations/set':'reserve','/api/admin/reservations/remove':'unreserve','/api/admin/claims/mint':'mintClaim','/api/admin/claims/link':'claimLink','/api/admin/claims/revoke':'revokeClaim','/api/admin/users/lookup':'lookup','/api/admin/users/roles':'setRoles','/api/admin/users/badges':'setBadges','/api/admin/users/suspend':'suspend','/api/admin/users/reactivate':'reactivate','/api/admin/principals':'principals','/api/admin/audit':'audit'};
export const adminPath=path=>path.startsWith('/api/admin/');
export async function adminRoutes({path,request,env,local,context,body,json}){
 if(!adminPath(path))return null;
 if(!env.ADMIN_SERVICE)return json({error:'admin_unavailable',message:'Administration is not configured.'},503);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
 if(request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf'},403);
 const admin=await env.ADMIN_SERVICE(),actor=request.headers.get('X-Bindle-Admin-Actor'),scoped={...context,origin:request.headers.get('Origin'),bootSession:bootSession(request,local),actor:['boot','admin'].includes(actor)?actor:undefined};
 if(path==='/api/admin/boot/begin'){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);await admin.limited('boot-begin',scoped);const binding=context.setupBinding||crypto.randomUUID()+crypto.randomUUID();return json({ready:true},200,{'Set-Cookie':`${local?'bindle_setup':'__Host-bindle_setup'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`});}
 // Logout and end always clear the boot cookie, even if the server-side record update fails.
 if(path==='/api/admin/boot/logout'){let result;try{result=await admin.bootLogout(await body(request,128),scoped);}catch(error){result={loggedOut:false,error:error.code||'invalid_request'};}return json(result,result.loggedOut?200:409,{'Set-Cookie':bootCookie('',local,0)});}
 if(BOOT[path]){const result=await admin[BOOT[path]](await body(request,16384),scoped),headers=new Headers();
  if(result.sessionToken){headers.append('Set-Cookie',bootCookie(result.sessionToken,local,Math.max(1,Math.floor((result.sessionExpiresAt-Date.now())/1000))));delete result.sessionToken;}
  if(path==='/api/admin/boot/logout'||path==='/api/admin/boot/end')headers.append('Set-Cookie',bootCookie('',local,0));return json(result,200,headers);}
 if(path==='/api/admin/step-up/begin')return json(await admin.identity.stepUpBegin(await body(request,128),scoped));
 // Administrators step up with a passkey only (coordinator decision, 2026-10-14).
 if(path==='/api/admin/step-up'){const input=await body(request,16384);if(input?.method!=='passkey')return json({error:'passkey_required',message:'Administrators confirm with a passkey. Add a passkey to this account first.'},403);return json(await admin.identity.stepUp(input,scoped));}
 if(path==='/api/admin/step-up/end')return json(await admin.endStepUp(await body(request,128),scoped));
 if(path==='/api/admin/access')return json(await admin.access(await body(request,128),scoped));
 if(OPERATIONS[path])return json(await admin[OPERATIONS[path]](await body(request,65536),scoped));
 return json({error:'not_found'},404);
}

// HTTP routes of slice 13a, Edge engine and identity (docs/architecture/app-engine.md §12): recovery authority, the signup gate, account sessions, device login and identity actions.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {accountSessionRoutes,installAccountSession} from '../account-session-http.mjs';
import {removedAccountCookies} from '../account-cookies.mjs';
import {recoveryAuthorityPublic} from '../identity-backup.mjs';
import {IdentityAction,OwnerQuery,LinkedApprovalAction,LinkedResolveQuery,IdentityFault} from '../../identity/index.mjs';
import {deviceAuthorizationEnabled} from '../device-grant.mjs';
import QRCode from 'qrcode';
import {json,body,cookie,signupEnabled,accountHandle,status} from './shared.mjs';

const authMethods={
 '/api/auth/step-up/begin':'stepUpBegin','/api/auth/step-up':'stepUp',
 '/api/auth/onboarding/issue':'issueOnboarding','/api/auth/onboarding/inspect':'inspectOnboarding','/api/auth/onboarding/claim':'claimOnboarding',
 '/api/auth/system/bootstrap':'bootstrapSystem',
 '/api/auth/setup/billing/checkout':'setupBillingCheckout','/api/auth/setup/billing/status':'setupBillingStatus','/api/auth/setup/status':'setupStatus','/api/auth/setup/email/start':'setupEmailStart','/api/auth/setup/email/confirm':'setupEmailConfirm','/api/auth/setup/push/start':'setupPushStart','/api/auth/setup/push/confirm':'setupPushConfirm',
 '/api/auth/handles/claim':'claimHandle','/api/auth/handles/certificate':'handleCertificate',
 '/api/auth/signup':'signup','/api/auth/passkey/register/begin':'beginPasskeyRegistration','/api/auth/passkey/register':'registerPasskey','/api/auth/password/pending':'setPendingPassword',
 '/api/auth/recovery/download':'downloadRecovery','/api/auth/recovery/confirm':'confirmRecovery','/api/auth/login/password':'loginPassword','/api/auth/login/passkey/begin':'beginPasskeyLogin',
 '/api/auth/login/passkey/finish':'finishPasskeyLogin','/api/auth/recover':'recover','/api/auth/logout':'logout','/api/auth/email/start':'emailStart','/api/auth/email/confirm':'emailConfirm','/api/auth/email/login/start':'emailLoginStart','/api/auth/email/login/confirm':'emailLoginConfirm'
 ,'/api/auth/passkeys/begin':'credentialBegin','/api/auth/passkeys/finish':'credentialFinish','/api/auth/passkeys/remove':'removePasskey','/api/auth/passkeys/rename':'renamePasskey','/api/auth/devices/rename':'renameSession','/api/auth/devices/revoke':'revokeSession','/api/auth/devices/revoke-others':'revokeOtherSessions'
 ,'/api/auth/device/start':'createDeviceLogin','/api/auth/device/approve':'approveDeviceLogin','/api/auth/device/deny':'denyDeviceLogin','/api/auth/device/poll':'pollDeviceLogin','/api/auth/device/cancel':'cancelDeviceLogin'
 ,'/api/auth/email/login/settings':'configureEmailLogin'
};

// Linked approval (LA3 mount of the LA1 contract, docs/architecture/linked-approval.md §10.1), all behind
// DEVICE_AUTHORIZATION_ENABLED; with the flag off these paths answer exactly like any other unknown /api/auth/ path.
// Requester side (LA5 screen): start/poll/accept/cancel with the tab's binding cookie. Approver side (LA4 page):
// resolve/approve/deny/configure for a signed-in member with that member's CSRF; app-kind review, consent and approval
// run through the device grant (owner shard) when the adapter mounted it. Responses are shaped for the page.
const LINKED_REQUESTER={'/api/auth/linked/start':'linkedStart','/api/auth/linked/poll':'linkedPoll','/api/auth/linked/accept':'linkedAccept','/api/auth/linked/cancel':'linkedCancel'};
const LINKED_MEMBER=['/api/auth/linked/resolve','/api/auth/linked/approve','/api/auth/linked/deny','/api/auth/linked/configure'];
const HOUR=3600000,SESSION_CHOICE={[HOUR]:'1h',[8*HOUR]:'8h'};
// Country and network trust only where the runtime's client address and geo source are authoritative (Workers).
const linkedContext=(request,context,local)=>{const country=request.cf?.country;return {...context,...!local&&request.headers.has('CF-Connecting-IP')&&typeof country==='string'&&/^[A-Z]{2}$/.test(country)?{country,networkTrusted:true}:{}};};
const deviceBindingCookie=(binding,local)=>`${local?'bindle_device':'__Host-bindle_device'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${local?'':'; Secure'}`;
/** The approval page's review shape from LA1's view (and, for apps, the owner shard's consent view). Freshness is
 * reported, never the credential time: the page treats it as UX and every decision re-checks it on the server. */
function approvalReview({linked:view,consent},authenticated,now){
 const app=view.kind==='app',sessionEnd=app?authenticated.expiresAt:view.durations.find(option=>option.choice==='session')?.expiresAt??authenticated.expiresAt;
 return {request:{id:view.requestId,kind:view.kind,createdAt:view.createdAt,expiresAt:view.expiresAt,...app?{client:{origin:`https://${view.app.host}`,reviewed:true}}:{deviceKind:view.requester.deviceKind},countryMismatch:view.warnings?.countryMismatch===true,sameBrowser:view.warnings?.sameBrowser===true},
  session:{expiresAt:sessionEnd,authAt:view.freshness?.satisfied===true?now-30000:null},...app?{consent:{requests:consent?.requests??[]}}:{}};
}
async function linkedRoutes({request,env,path,local,engine,context,vault}){
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 const input=await body(request,16384),ctx=linkedContext(request,context,local),grant=env.DEVICE_GRANT?.mounted===true?env.DEVICE_GRANT:null;
 const run=async(method,value)=>(await engine.dispatch(new LinkedApprovalAction(method,value,ctx)).next('result')).detail;
 try{
  if(LINKED_REQUESTER[path]){
   const headers=new Headers();
   if(path==='/api/auth/linked/start')ctx.deviceBinding=crypto.randomUUID()+crypto.randomUUID();
   const result=await run(LINKED_REQUESTER[path],path==='/api/auth/linked/start'?{deviceKind:input.deviceKind,turnstileToken:input.turnstileToken}:{deviceCode:input.deviceCode});
   if(path==='/api/auth/linked/start')headers.append('Set-Cookie',deviceBindingCookie(ctx.deviceBinding,local));
   if(result.sessionToken){if(result.account?.id)try{await accountHandle(env,result.account.id).touch(result.account.id);}catch{}if(vault){for(const value of await installAccountSession({request,env,local,engine,context:ctx,result,legacyCleared:cookie('',local,0)}))headers.append('Set-Cookie',value);}else headers.append('Set-Cookie',cookie(result.sessionToken,local));delete result.sessionToken;}
   return json(result,200,headers);
  }
  const authenticated=await engine.query(new OwnerQuery(context)).peek(),owner=authenticated.account.id;
  if(context.csrfToken!==authenticated.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
  const review=async()=>approvalReview(grant?await grant.review({owner,context:ctx,code:input.code,...input.locator!==undefined?{requestId:input.locator}:{},...input.turnstileToken?{turnstileToken:input.turnstileToken}:{}}):{linked:await engine.query(new LinkedResolveQuery({code:input.code,...input.locator!==undefined?{locator:input.locator}:{},...input.turnstileToken?{turnstileToken:input.turnstileToken}:{}},ctx)).peek()},authenticated,Date.now());
  if(path==='/api/auth/linked/resolve')return json(await review());
  if(path==='/api/auth/linked/deny')return json(await run('linkedDeny',{requestId:input.requestId,code:input.code}));
  if(path==='/api/auth/linked/configure'){
   if(!grant||!env.FEDERATION_AUTHORITY)return json({error:'invalid_code',message:'That code does not match.'},400);
   await env.FEDERATION_AUTHORITY.configure(context,{fragment:input.fragment,values:input.values,expectedRevision:input.expectedRevision,reviewedConsumerDigest:input.reviewedConsumerDigest,...input.updateShared===true?{updateShared:true}:{}});
   input.locator=input.requestId;return json(await review());
  }
  // approve: the page names the member it reviewed as; it must still be this tab's member.
  if(input.owner!==undefined&&input.owner!==owner||input.sessionContext!==undefined&&input.sessionContext!==authenticated.sessionContext)return json({error:'account_context_conflict',message:'Reload the account chooser before continuing.'},409);
  // A present but malformed choice never falls back to a default lifetime (LA3-S5).
  if(input.choice!==undefined&&!(typeof input.choice==='string'||Array.isArray(input.consent)===false&&Number.isSafeInteger(input.choice)))return json({error:'invalid_choice',message:'Choose how long this sign-in lasts.'},400);
  await accountHandle(env,owner).touch(owner);
  if(Array.isArray(input.consent)){
   if(!grant)return json({error:'invalid_code',message:'That code does not match.'},400);
   return json(await grant.approve({owner,context:ctx,requestId:input.requestId,code:input.code,approved:input.consent,...typeof input.choice==='string'?{choice:input.choice}:{}}));
  }
  return json(await run('linkedApprove',{requestId:input.requestId,code:input.code,approved:true,...input.choice!==undefined?{choice:typeof input.choice==='number'?SESSION_CHOICE[input.choice]??'session':input.choice}:{}}));
 }catch(error){
  if(typeof error?.code!=='string'||error instanceof IdentityFault)throw error;
  return json({error:error.code,message:error.message||'The request could not be completed.'},status(error),Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{'Retry-After':String(error.retryAfter)}:{});
 }
}

export function allowedMethods(path){
 if(path==='/api/auth/accounts')return ['GET'];
 if(path.startsWith('/api/auth/'))return ['POST'];
 return null;
}
export const stages={
 async anonymous({request,env,path}){
   if(path==='/api/recovery/authority'){if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});return json(recoveryAuthorityPublic(env));}
 },
 async api({request,env,path}){
    if(path==='/api/auth/signup'&&request.method==='POST'&&!signupEnabled(env))return json({error:'release_gated',message:'Account creation is not open yet.'},503);
 },
 async session({request,env,path,local,engine,context,vault,accountPath,accountMember}){
    if(accountPath)return await accountSessionRoutes({request,env,local,engine,context,body,json,legacyCleared:cookie('',local,0)});
    if(['/api/auth/signup','/api/auth/recover','/api/auth/login/password','/api/auth/login/passkey/finish'].includes(path))context.setupBinding=crypto.randomUUID()+crypto.randomUUID();
    if(path==='/api/auth/device/start')context.deviceBinding=crypto.randomUUID()+crypto.randomUUID();
    if(deviceAuthorizationEnabled(env)&&(LINKED_REQUESTER[path]||LINKED_MEMBER.includes(path)))return await linkedRoutes({request,env,path,local,engine,context,vault});
    // QR codes carry a locator, never a code (LA-5): the legacy /device#request= form, and with the flag on the
    // linked /approve#r= form.
    if(path==='/api/auth/device/qr'){
      const input=await body(request);let qr;try{qr=new URL(input.verificationUriComplete);}catch{return json({error:'invalid_request'},400);}
      const legacy=qr.pathname==='/device'&&/^#request=[a-f0-9-]{36}$/.test(qr.hash),linked=deviceAuthorizationEnabled(env)&&qr.pathname==='/approve'&&/^#r=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(qr.hash);
      if(qr.origin!==env.APP_ORIGIN||qr.search||!(legacy||linked)||qr.username||qr.password)return json({error:'invalid_request'},400);return json({svg:await QRCode.toString(qr.href,{type:'svg',width:320,margin:2})});
    }
    if(authMethods[path]){
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      if(path==='/api/auth/signup'&&!signupEnabled(env))return json({error:'release_gated',message:'Account creation is not open yet.'},503);
      const input=await body(request);
      // Sign-out also forgets this device's push subscription for that account (best effort).
      if(path==='/api/auth/logout'&&Object.hasOwn(input,'pushSubscription')){const id=input.pushSubscription;delete input.pushSubscription;if(typeof id==='string'&&/^[A-Za-z0-9_-]{43}$/.test(id))try{const signedIn=await engine.query(new OwnerQuery(context)).peek();await accountHandle(env,signedIn.account.id).removeSubscription(signedIn.account.id,id);}catch{}}
      if(['credentialBegin','credentialFinish','renamePasskey','renameSession','approveDeviceLogin','emailStart','emailConfirm','configureEmailLogin'].includes(authMethods[path])){
        const authenticated=await engine.query(new OwnerQuery(context)).peek();
        if(context.csrfToken!==authenticated.csrfToken)return json({error:'csrf',message:'Reload the account page before continuing.'},403);
        await accountHandle(env,authenticated.account.id).touch(authenticated.account.id);
      }
      const event=await engine.dispatch(new IdentityAction(authMethods[path],input,context)).next('result');const result=event.detail;
      if(['/api/auth/signup','/api/auth/system/bootstrap','/api/auth/onboarding/claim'].includes(path)&&result.account?.status==='pending')await accountHandle(env,result.account.id).rememberSignupOrigin(result.account.id,{createdAt:result.account.createdAt});
      if(result.sessionToken&&result.account?.id){try{await accountHandle(env,result.account.id).touch(result.account.id);result.billingSync=await accountHandle(env,result.account.id).billingRefresh(result.account.id,{force:true});}catch{result.billingSync={checked:false,error:'billing_provider_unavailable'};}}
      const headers=new Headers();if(result.pendingToken&&context.setupBinding)headers.append('Set-Cookie',`${local?'bindle_setup':'__Host-bindle_setup'}=${context.setupBinding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`);if(result.sessionToken){if(vault){for(const value of await installAccountSession({request,env,local,engine,context,result,legacyCleared:cookie('',local,0)}))headers.append('Set-Cookie',value);}else headers.append('Set-Cookie',cookie(result.sessionToken,local));delete result.sessionToken;}if(path==='/api/auth/logout'){if(accountMember)for(const value of removedAccountCookies(accountMember.owner,local))headers.append('Set-Cookie',value);else headers.append('Set-Cookie',cookie('',local,0));}
      if(path==='/api/auth/device/start')headers.append('Set-Cookie',`${local?'bindle_device':'__Host-bindle_device'}=${context.deviceBinding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${local?'':'; Secure'}`);
      return json(result,200,headers);
    }
 },
};

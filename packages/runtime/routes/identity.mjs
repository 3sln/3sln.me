// HTTP routes of slice 13a, Edge engine and identity (docs/architecture/app-engine.md §12): recovery authority, the signup gate, account sessions, device login and identity actions.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {accountSessionRoutes,installAccountSession} from '../account-session-http.mjs';
import {removedAccountCookies} from '../account-cookies.mjs';
import {recoveryAuthorityPublic} from '../identity-backup.mjs';
import {IdentityAction,OwnerQuery} from '../../identity/index.mjs';
import QRCode from 'qrcode';
import {json,body,cookie,signupEnabled,accountHandle} from './shared.mjs';

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
    if(path==='/api/auth/device/qr'){
      const input=await body(request);let qr;try{qr=new URL(input.verificationUriComplete);}catch{return json({error:'invalid_request'},400);}if(qr.origin!==env.APP_ORIGIN||qr.pathname!=='/device'||qr.search||!/^#request=[a-f0-9-]{36}$/.test(qr.hash)||qr.username||qr.password)return json({error:'invalid_request'},400);return json({svg:await QRCode.toString(qr.href,{type:'svg',width:320,margin:2})});
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

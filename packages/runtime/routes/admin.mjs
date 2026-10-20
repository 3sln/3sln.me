// HTTP routes of slice 13b, Admin, boot, abuse, waitlist and signup capacity (docs/architecture/app-engine.md §12): signup plans and status, the waitlist, onboarding and system-bootstrap entry, host administration.
// Stage handlers and route-module shape: packages/runtime/routes/index.mjs.
import {onboardingEnabled,onboardingOnly} from '../../identity/onboarding.mjs';
import {adminRoutes,adminPath} from '../admin-http.mjs';
import {signupCapacityLimits} from '../../core/abuse-policy.mjs';
import {waitlistEmail} from '../waitlist.mjs';
import {paidSignupEnabled,paidSignupPlans} from '../../billing/signup.mjs';
import {cachedSignupCapacity} from '../signup-status.mjs';
import {json,body,limit,consume,pseudonym,subnet,turnstile,signupEnabled,setupCookie,privateHeaders} from './shared.mjs';

export const stages={
 async public({request,env,execution,url,path,local}){
   if(path==='/api/signup/plans'){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    if(!paidSignupEnabled(env))return json({error:'paid_signup_unavailable',message:'Paid signup is not available.'},503);
    if(url.searchParams.getAll('currency').length>1)return json({error:'invalid_currency'},400);
    if(!await limit(env,{operation:'signup-plans',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    const value=await paidSignupPlans(env,url.searchParams.get('currency')??undefined);
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{...privateHeaders,'Content-Type':'application/json'}});
   }
   if(path==='/api/signup/status'){
    if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    const enabled=signupEnabled(env);let capacity=null;if(enabled)try{capacity=await cachedSignupCapacity(env,execution);}catch{}
    const paidEnabled=paidSignupEnabled(env),freeOpen=enabled&&capacity?.freeAvailable===true,paidOpen=enabled&&paidEnabled&&capacity?.globalAvailable===true;
    const value={onboardingOnly:onboardingOnly(env),tokenOnboardingEnabled:onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true,signupEnabled:enabled,freeSignupOpen:freeOpen,paidSignupEnabled:paidEnabled,paidSignupOpen:paidOpen,signupOpen:freeOpen||paidOpen,capacityAvailable:capacity?.freeAvailable??null,reason:!enabled?'disabled':!capacity?'unavailable':!capacity.globalAvailable?'global_capacity':!capacity.freeAvailable?'free_capacity':'open',waitlistEnabled:env.WAITLIST_ENABLED==='true'&&env.WAITLIST_MAIL_AVAILABLE===true};
    return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{...privateHeaders,'Content-Type':'application/json','Cache-Control':`public, max-age=${capacity?Math.max(0,Math.floor((capacity.cacheUntil-Date.now())/1000)):0}, must-revalidate`}});
   }
 },
 async unauthenticated({request,env,path,local}){
   if(['/api/waitlist/start','/api/waitlist/confirm','/api/waitlist/leave'].includes(path)){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if((path!=='/api/waitlist/leave'&&env.WAITLIST_ENABLED!=='true')||(path==='/api/waitlist/start'&&env.WAITLIST_MAIL_AVAILABLE!==true)||typeof env.ABUSE?.waitlist!=='function')return json({error:'waitlist_unavailable',message:'The waitlist is not available.'},503);
    const input=await body(request,4096),secret=env.ABUSE_HASH_KEY||env.KEY_ENCRYPTION_KEY,remoteIP=request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown');
    if(!secret)return json({error:'waitlist_unavailable'},503);
    const ip=await pseudonym(remoteIP,secret),network=await pseudonym(subnet(remoteIP),secret),starting=path.endsWith('/start');
    if(!await consume(env,'waitlist:ip:'+ip,3600000,starting?3:30)||!await consume(env,'waitlist:network:'+network,3600000,starting?20:100))return json({error:'rate_limited',message:'Please wait before trying again.'},429,{'Retry-After':'3600'});
    if(!starting&&!await consume(env,'waitlist:proof-service:'+parseInt(ip.slice(0,2),16)%16,60000,100))return json({error:'rate_limited'},429,{'Retry-After':'60'});
    if(!starting)return json(await env.ABUSE.waitlist(path.endsWith('/confirm')?'confirm':'leave',input));
    const email=waitlistEmail(input.email);
    if(!await turnstile(env,{token:input.turnstileToken,remoteIP,hostname:new URL(env.APP_ORIGIN).hostname,action:'waitlist'}))return json({error:'challenge_failed',message:'Complete the verification challenge.'},403);
    const capacity=await env.ABUSE.signupStatus('signup:lifetime-admission',signupCapacityLimits(env));
    const target=await pseudonym('waitlist-target-v1:'+env.APP_ORIGIN+':'+email,secret);
    if(!await consume(env,'waitlist:target-cooldown:'+target,600000,1)||!await consume(env,'waitlist:target-day:'+target,86400000,3))return json({accepted:true},202);
    for(const [name,windowMs,maximum]of [['minute',60000,10],['hour',3600000,100],['day',86400000,500]])if(!await consume(env,'waitlist:mail:'+name,windowMs,maximum))return json({accepted:true},202);
    const result=await env.ABUSE.waitlist('prepare',{email,locale:input.locale,allowNew:!signupEnabled(env)||!capacity.freeAvailable||env.WAITLIST_ALLOW_OPEN==='true'});
    if(result.mail){let timer;try{await Promise.race([env.WAITLIST_MAILER.sendWaitlistConfirmation(result.mail),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mail outcome unknown')),15000);timer.unref?.();})]);}catch{}finally{clearTimeout(timer);}}
    return json({accepted:true},202);
   }
   if(path.startsWith('/api/auth/onboarding/')){
    if(!['/api/auth/onboarding/begin','/api/auth/onboarding/issue','/api/auth/onboarding/inspect','/api/auth/onboarding/claim'].includes(path))return json({error:'not_found'},404);
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(!(onboardingEnabled(env)||env.ADMIN_CLAIMS_ENABLED===true)||!env.RECOVERY_SIGNING_KEY||env.SIGNUP_CONTACT_REQUIRED==='true'&&!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true))return json({error:'onboarding_unavailable',message:'Account onboarding is not configured.'},503);
    if(request.headers.get('Origin')!==env.APP_ORIGIN)return json({error:'csrf'},403);
    if(!await limit(env,{operation:'onboarding-'+path.split('/').at(-1),remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429);
    if(path.endsWith('/begin')){const input=await body(request,128);if(Object.keys(input).length)return json({error:'invalid_request'},400);const binding=setupCookie(request,local)||crypto.randomUUID()+crypto.randomUUID();return json({ready:true},200,{'Set-Cookie':`${local?'bindle_setup':'__Host-bindle_setup'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`});}
   }
   if(path==='/api/auth/system/bootstrap'&&(!env.SYSTEM_BOOTSTRAP_KEY||!env.RECOVERY_SIGNING_KEY||!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true)))return json({error:'system_bootstrap_unavailable',message:'System setup is not configured.'},503);
   if(path==='/api/auth/system/bootstrap/begin'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
    if(!env.SYSTEM_BOOTSTRAP_KEY||!env.RECOVERY_SIGNING_KEY||!(env.EMAIL_SETUP_AVAILABLE===true||env.PUSH_AVAILABLE===true))return json({error:'system_bootstrap_unavailable',message:'System setup is not configured.'},503);
    if(!await limit(env,{operation:'system-bootstrap-begin',remoteIP:request.headers.get('CF-Connecting-IP')||(local?'127.0.0.1':'unknown')}))return json({error:'rate_limited'},429);
    const binding=setupCookie(request,local)||crypto.randomUUID()+crypto.randomUUID();return json({ready:true},200,{'Set-Cookie':`${local?'bindle_setup':'__Host-bindle_setup'}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${local?'':'; Secure'}`});
   }
 },
 async session({request,env,path,local,context}){
    // Host administration (boot-and-admin): explicit actor header and its own boot cookie; inert without configuration.
    if(adminPath(path))return await adminRoutes({path,request,env,local,context,body,json});
 },
};

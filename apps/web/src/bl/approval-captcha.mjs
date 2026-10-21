// Inline approval sign-in uses the same login Turnstile action as the other sign-in surfaces.
export function createApprovalCaptcha(win){
 let config,pending,observer,script,disposed=false,node,widget,token='';const used=new Set();
 const clear=()=>{token='';if(widget!==undefined)win.turnstile?.remove(widget);widget=undefined;node=null;};
 const mount=()=>{
  if(disposed||!config?.turnstileSiteKey||config.localDevelopment)return;
  const target=win.document.querySelector('[data-approval-captcha]');if(target===node)return;clear();
  if(!target||!win.turnstile)return;node=target;const live=()=>!disposed&&node===target&&target.isConnected;
  widget=win.turnstile.render(target,{sitekey:config.turnstileSiteKey,size:'flexible',appearance:'interaction-only',action:'login',callback:value=>{if(live()&&!used.has(value))token=value;},'expired-callback':()=>{if(live())token='';},'error-callback':()=>{if(live())token='';}});
 };
 const install=()=>pending??=(async()=>{
  const response=await win.fetch('/api/config',{credentials:'same-origin',cache:'no-store',signal:win.AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Sign-in configuration unavailable.');config=await response.json();if(disposed||!config.turnstileSiteKey||config.localDevelopment)return;
  observer=new win.MutationObserver(mount);observer.observe(win.document.getElementById('app'),{childList:true,subtree:true});
  if(win.turnstile){mount();return;}script=win.document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=mount;win.document.head.append(script);
 })();
 return {install,async proof(){await install();if(config.localDevelopment===true)return {turnstileToken:'local-browser-test-token'};if(!config.turnstileSiteKey)return {};if(!token)throw Object.assign(new Error('The security check is still running. Please wait a moment and try again.'),{code:'challenge_pending'});const value=token;used.add(value);token='';if(widget!==undefined)win.turnstile?.reset(widget);return {turnstileToken:value};},dispose(){disposed=true;observer?.disconnect();clear();script?.remove();}};
}

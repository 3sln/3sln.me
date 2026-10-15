import { Provider } from '../shared/stack.mjs';
import { decodeOptions, serializeCredential } from '../bl/browser-codecs.mjs';
// Browser capabilities for the administration console: route, clock, passkeys,
// clipboard, token file import and focus. Secrets (the boot token while setup is
// in progress, WebAuthn challenges) stay in this closure and never enter state.
export default class AdminBrowserProvider extends Provider {
  #resource=createAdminBrowser();
  async obtain(){return this.#resource;}
  release(){}
  dispose(){this.#resource.dispose();}
}
export const TOKEN_FILE_FORMAT='bindle-boot-token/v1';
/** Accepts a pasted `boot1.` token or the CLI's JSON file text. Origin and
 * freshness are checked locally only to give a clear message; the server decides. */
export function parseBootToken(text,{origin,now=Date.now()}={}){
  const value=typeof text==='string'?text.trim():'';
  if(!value||value.length>4096)throw Object.assign(new Error('Paste the boot token or import the token file.'),{code:'token_missing'});
  if(value.startsWith('{')){let file;try{file=JSON.parse(value);}catch{file=null;}
    if(file?.format!==TOKEN_FILE_FORMAT||typeof file.token!=='string')throw Object.assign(new Error('This is not a boot token file.'),{code:'token_file_invalid'});
    if(typeof file.issuer==='string'&&origin&&file.issuer!==origin)throw Object.assign(new Error('This token was minted for another origin.'),{code:'token_wrong_origin',issuer:file.issuer});
    if(Number.isSafeInteger(file.usableUntil)&&file.usableUntil<=now)throw Object.assign(new Error('This token is older than its 30-minute window.'),{code:'token_stale'});
    return parseBootToken(file.token,{origin,now});}
  if(!/^boot1\.[A-Za-z0-9_-]{40,480}$/.test(value))throw Object.assign(new Error('This does not look like a boot token.'),{code:'token_malformed'});
  try{const claims=JSON.parse(atob(value.slice(6).replace(/-/g,'+').replace(/_/g,'/')));if(origin&&typeof claims?.iss==='string'&&claims.iss!==origin)throw Object.assign(new Error('This token was minted for another origin.'),{code:'token_wrong_origin',issuer:claims.iss});}catch(error){if(error.code)throw error;}
  return value;
}
export function adminRoute(location){const query=new URLSearchParams(location.search);return {mode:query.has('boot')?'boot':'admin',locale:query.get('lang')};}
function createAdminBrowser(){
  const secrets=new Map(),timers=new Set();let returnFocus=null;
  return {
    route:()=>adminRoute(location),
    origin:()=>location.origin,
    now:()=>Date.now(),
    language:()=>navigator.language,
    applyLocale(locale){document.documentElement.lang=locale;},
    setTitle(text){document.title=text;},
    every(ms,callback){const timer=setInterval(callback,ms);timers.add(timer);return ()=>{clearInterval(timer);timers.delete(timer);};},
    secret:name=>secrets.get(name)??null,
    storeSecret(name,value){if(value===null||value===undefined)secrets.delete(name);else secrets.set(name,value);},
    clearSecrets(){secrets.clear();},
    async readTokenFile(file){if(!file||typeof file.text!=='function')throw Object.assign(new Error('Choose the boot token file.'),{code:'token_missing'});if(file.size>4096)throw Object.assign(new Error('This is not a boot token file.'),{code:'token_file_invalid'});return file.text();},
    async createPasskey(options){if(!navigator.credentials?.create)throw Object.assign(new Error('This browser does not support passkeys.'),{code:'passkey_unsupported'});try{return serializeCredential(await navigator.credentials.create({publicKey:decodeOptions(options)}));}catch(error){throw Object.assign(new Error('The passkey was not created.'),{code:error?.name==='InvalidStateError'?'passkey_exists':'passkey_cancelled'});}},
    async authenticatePasskey(options){if(!navigator.credentials?.get)throw Object.assign(new Error('This browser does not support passkeys.'),{code:'passkey_unsupported'});try{return serializeCredential(await navigator.credentials.get({publicKey:decodeOptions(options)}));}catch{throw Object.assign(new Error('The passkey check was cancelled.'),{code:'passkey_cancelled'});}},
    async copy(text){await navigator.clipboard.writeText(text);},
    navigate(url){location.assign(url);},
    rememberFocus(){returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;},
    restoreFocus(){const target=returnFocus;returnFocus=null;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(target?.isConnected&&!target.closest('[inert]'))target.focus();else document.getElementById('admin-main')?.focus();}));},
    focus(selector){requestAnimationFrame(()=>requestAnimationFrame(()=>{const node=document.querySelector(selector);if(node instanceof HTMLElement)node.focus();}));},
    dispose(){secrets.clear();for(const timer of timers)clearInterval(timer);timers.clear();}
  };
}

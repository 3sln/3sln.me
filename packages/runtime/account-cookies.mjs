import {encode,decode} from '../identity/crypto.mjs';
// Independently named AEAD member cookies. Each cookie is transport custody for
// one owner session; the owner repository stays the only session authority.
export const MAX_ACCOUNTS=5,MAX_OBSERVED=8;
const utf8=new TextEncoder(),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const accountFault=(code,status=400,message='Reload the account chooser before continuing.')=>Object.assign(new Error(message),{code,status});
const memberPrefix=local=>local?'bindle_account_':'__Host-bindle_account_';
export const accountCookieName=(owner,local)=>memberPrefix(local)+owner;
const defaultName=local=>local?'bindle_default_account':'__Host-bindle_default_account';
const cleanupName=local=>local?'bindle_account_cleanup':'__Host-bindle_account_cleanup';
export function accountCookiesEnabled(env){return typeof env.SESSION_COOKIE_KEY==='string'&&/^[A-Za-z0-9_-]{43}$/.test(env.SESSION_COOKIE_KEY)&&encode(decode(env.SESSION_COOKIE_KEY))===env.SESSION_COOKIE_KEY;}
// Duplicate names fail closed rather than letting cookie order choose a member.
export function parseAccountCookies(request,local){
 const result=new Map();for(const piece of (request.headers.get('Cookie')||'').split(';')){const i=piece.indexOf('=');if(i<0)continue;const name=piece.slice(0,i).trim(),value=piece.slice(i+1).trim();if(!name.startsWith(memberPrefix(local))&&name!==defaultName(local)&&name!==cleanupName(local))continue;if(result.has(name))throw accountFault('invalid_account_cookie',401);result.set(name,value);}
 return result;
}
export const memberNames=(cookies,local)=>[...cookies.keys()].filter(name=>name.startsWith(memberPrefix(local))&&name!==cleanupName(local));
export const hasAccountVault=(cookies,local)=>memberNames(cookies,local).length>0||cookies.has(defaultName(local));
async function key(env){if(!accountCookiesEnabled(env))throw accountFault('accounts_unavailable',503);return crypto.subtle.importKey('raw',decode(env.SESSION_COOKIE_KEY),'AES-GCM',false,['encrypt','decrypt']);}
const aad=(env,purpose,name)=>utf8.encode(`${env.APP_ORIGIN}\0${purpose}\0${name}\0v1`);
export async function sealAccountValue(env,purpose,name,value){const nonce=crypto.getRandomValues(new Uint8Array(12));const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(env,purpose,name)},await key(env),utf8.encode(JSON.stringify(value)));return 'ac1.'+encode(nonce)+'.'+encode(new Uint8Array(bytes));}
// Authenticate before parsing: tampered, foreign-origin or renamed values never reach JSON.
export async function openAccountValue(env,purpose,name,raw){try{if(typeof raw!=='string'||raw.length>3800||!/^ac1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(raw))throw 0;const [,nonce,ciphertext]=raw.split('.');const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(nonce),additionalData:aad(env,purpose,name)},await key(env),decode(ciphertext));const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);if(JSON.stringify(value)!==text||!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw accountFault('invalid_account_cookie',401);}}
function validMember(value,owner,now){return !!value&&Object.keys(value).sort().join(',')==='expiresAt,owner,sessionContext,token'&&value.owner===owner&&uuid.test(owner)&&typeof value.token==='string'&&value.token.length===80&&value.token.startsWith(owner+'.')&&/^[A-Za-z0-9_-]{43}$/.test(value.token.slice(37))&&typeof value.sessionContext==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionContext)&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt<=now+86400000;}
export async function readAccountMember(env,cookies,owner,local,now=Date.now()){if(!uuid.test(owner||''))throw accountFault('account_context_conflict',409);const name=accountCookieName(owner,local),raw=cookies.get(name);if(!raw)throw accountFault('account_unavailable',401);const value=await openAccountValue(env,'session',name,raw);if(!validMember(value,owner,now))throw accountFault('account_unavailable',401);return value;}
// Bounded explicit enumeration for chooser/installation only; never on ordinary owner requests.
export async function observedAccountMembers(env,cookies,local,now=Date.now(),max=MAX_OBSERVED){
 const names=memberNames(cookies,local);if(names.length>max)throw accountFault('account_limit',409,'Sign out of all accounts in this browser, then sign in again.');const members=[],stale=[];for(const name of names){try{members.push(await readAccountMember(env,cookies,name.slice(memberPrefix(local).length),local,now));}catch(error){if(!['invalid_account_cookie','account_unavailable','account_context_conflict'].includes(error.code))throw error;stale.push(name);}}return Object.assign(members,{stale});
}
export async function accountSnapshotRevision(members){return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(JSON.stringify(members.map(m=>[m.owner,m.sessionContext]).sort((a,b)=>a[0].localeCompare(b[0])))))));}
export async function defaultAccountOwner(env,cookies,local){const raw=cookies.get(defaultName(local));if(!raw)return null;const value=await openAccountValue(env,'default',defaultName(local),raw);if(Object.keys(value).join(',')!=='owner'||!uuid.test(value.owner))throw accountFault('invalid_account_cookie',401);return value.owner;}
// Tab-bound selection: an explicit owner must name an authenticated member and
// carry its session context. Only header-less discovery uses the default member.
export async function selectedAccountMember(request,env,local,cookies=parseAccountCookies(request,local)){const owner=request.headers.get('X-Bindle-Account'),expected=request.headers.get('X-Bindle-Session-Context');if(owner!==null&&!expected||owner===null&&expected!==null)throw accountFault('account_context_conflict',409);if(owner===null){const fallback=await defaultAccountOwner(env,cookies,local).catch(()=>null);return fallback?readAccountMember(env,cookies,fallback,local).catch(()=>null):null;}const member=await readAccountMember(env,cookies,owner,local);if(expected!==null&&expected!==member.sessionContext)throw accountFault('session_context_conflict',409);return member;}
export function serializeAccountCookie(name,value,local,maxAge){return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(maxAge))}${local?'':'; Secure'}`;}
export async function installedAccountCookies(env,member,local){if(!validMember(member,member.owner,Date.now()))throw accountFault('invalid_session',500,'Sign-in did not create a verified account session.');const name=accountCookieName(member.owner,local);return [serializeAccountCookie(name,await sealAccountValue(env,'session',name,member),local,(member.expiresAt-Date.now())/1000),await defaultAccountCookie(env,member.owner,local)];}
export async function defaultAccountCookie(env,owner,local){return serializeAccountCookie(defaultName(local),await sealAccountValue(env,'default',defaultName(local),{owner}),local,86400);}
export const removedMemberCookie=(name,local)=>serializeAccountCookie(name,'',local,0);
export const clearedDefaultCookie=local=>serializeAccountCookie(defaultName(local),'',local,0);
export function removedAccountCookies(owner,local,clearDefault=true){return [removedMemberCookie(accountCookieName(owner,local),local),...clearDefault?[clearedDefaultCookie(local)]:[]];}
// Picker proof: a private same-origin CSRF/continuation value for the exact
// observed member snapshot. It is not membership authority by itself.
const pairs=members=>members.map(m=>[m.owner,m.sessionContext]).sort((a,b)=>a[0].localeCompare(b[0]));
export async function createPickerToken(env,members,revision,now=Date.now()){return sealAccountValue(env,'picker','picker',{revision,targets:pairs(members),expiresAt:now+120000});}
export async function verifyPickerToken(env,raw,members,revision,now=Date.now()){const value=await openAccountValue(env,'picker','picker',raw).catch(()=>{throw accountFault('vault_conflict',409);});if(Object.keys(value).sort().join(',')!=='expiresAt,revision,targets'||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+120000||value.revision!==revision||!Array.isArray(value.targets)||JSON.stringify(value.targets)!==JSON.stringify(pairs(members)))throw accountFault('vault_conflict',409);return true;}
// Retry-only custody for unresolved revocations. It cannot select, list or
// authenticate ordinary owner requests and lives no longer than its sessions.
export async function cleanupAccountCookie(env,members,local,now=Date.now()){const name=cleanupName(local),live=members.filter(m=>m.expiresAt>now).slice(0,MAX_OBSERVED);if(!live.length)return clearCleanupCookie(local);const expiresAt=Math.max(...live.map(m=>m.expiresAt));return serializeAccountCookie(name,await sealAccountValue(env,'cleanup',name,{members:live,expiresAt}),local,(expiresAt-now)/1000);}
export async function readCleanupMembers(env,cookies,local,now=Date.now()){const name=cleanupName(local),raw=cookies.get(name);if(!raw)return [];const value=await openAccountValue(env,'cleanup',name,raw);if(Object.keys(value).sort().join(',')!=='expiresAt,members'||!Number.isSafeInteger(value.expiresAt)||value.expiresAt>now+86400000||!Array.isArray(value.members)||value.members.length>MAX_OBSERVED||value.members.some(m=>!validMember(m,m?.owner,Math.min(now,m?.expiresAt-1))))throw accountFault('invalid_account_cookie',401);return value.members.filter(m=>m.expiresAt>now);}
export function clearCleanupCookie(local){return serializeAccountCookie(cleanupName(local),'',local,0);}

// IA-4 / incremental-authorization §7.2. Public inputs only; never render reason, requests or suggestions.
import {isPlainData,messageBytes,LIMITS,PROFILE} from '../islands-protocol.mjs';
export const REQUEST_KINDS=Object.freeze(['grant-more','configure']);
export const REQUEST_TEXT=Object.freeze({en:Object.freeze({access:'Review access',settings:'Review settings',continue:'Continue at {host}',busy:'Waiting for your provider…',finished:'Review finished.',canceled:'Review canceled.',unavailable:'Review is unavailable.',declined:'Request declined.',unchanged:'No settings changed.',blocked:'Your browser blocked the review window.'}),es:Object.freeze({access:'Revisar acceso',settings:'Revisar ajustes',continue:'Continuar en {host}',busy:'Esperando a tu proveedor…',finished:'Revisión finalizada.',canceled:'Revisión cancelada.',unavailable:'La revisión no está disponible.',declined:'Solicitud rechazada.',unchanged:'No se cambiaron los ajustes.',blocked:'Tu navegador bloqueó la ventana de revisión.'})});
export const requestText=locale=>REQUEST_TEXT[String(locale).toLowerCase().split('-')[0]]??REQUEST_TEXT.en;
const own=(v,k)=>Object.hasOwn(v,k),b64=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const url=v=>{try{const u=new URL(v);return typeof v==='string'&&v.length<=2048&&u.href===v&&u.protocol==='https:'&&!u.username&&!u.password&&!u.hash?u:null;}catch{return null;}};
const names=(v,max=64)=>Array.isArray(v)&&v.length>0&&v.length<=max&&new Set(v).size===v.length&&v.every(n=>typeof n==='string'&&n.length>0&&n.length<=2048);
const digest=v=>v===undefined||typeof v==='string'&&/^sha256-[A-Za-z0-9_-]{43}$/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
/** No IO. Validation also runs in the provider frame; the app element is never a security boundary. */
export function validatePrepareRequest(data,{kind,origins=[]}={}){
 try{
  if(!isPlainData(data)||!object(data)||messageBytes(data)>LIMITS.prepare||data.v!==1||data.type!=='prepare-request'||!REQUEST_KINDS.includes(data.intent)||kind!==undefined&&data.intent!==kind)return null;
  const allowed=['v','type','intent','redirectUri','state','challenge','requests','target','suggestion','reason','uiLocales','colorScheme','dpopJkt'];
  if(Object.keys(data).some(k=>!allowed.includes(k))||!b64(data.state)||!origins.includes(url(data.redirectUri)?.origin))return null;
  if(own(data,'reason')&&(typeof data.reason!=='string'||[...data.reason].length>200)||own(data,'uiLocales')&&(!Array.isArray(data.uiLocales)||data.uiLocales.length>4||data.uiLocales.some(v=>typeof v!=='string'||v.length>35||!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(v)))||own(data,'colorScheme')&&!['light','dark'].includes(data.colorScheme)||own(data,'dpopJkt')&&!b64(data.dpopJkt))return null;
  if(data.intent==='grant-more'){
   if(!b64(data.challenge)||own(data,'target')||own(data,'suggestion')||!Array.isArray(data.requests)||!data.requests.length||data.requests.length>4||new Set(data.requests.map(r=>r?.fragment)).size!==data.requests.length)return null;
   for(const r of data.requests){
    if(!object(r)||!url(r.fragment)||!digest(r.digest)||r.required!==undefined&&r.required!==false||r.fields!==undefined&&!names(r.fields)||r.methods!==undefined&&!object(r.methods))return null;
    for(const [field,contracts]of Object.entries(r.methods??{})){if(!field||r.fields&&!r.fields.includes(field)||!object(contracts))return null;for(const [contract,methods]of Object.entries(contracts))if(!url(contract)||!names(methods))return null;}
   }
  }else{
   const t=data.target,s=data.suggestion;
   if(own(data,'challenge')||own(data,'requests')||own(data,'dpopJkt')||!object(t)||Object.keys(t).some(k=>!['fragment','digest','fields'].includes(k))||!url(t.fragment)||!digest(t.digest)||t.fields!==undefined&&!names(t.fields,8))return null;
   if(s!==undefined&&(!object(s)||Object.keys(s).join()!=='values'||!object(s.values)||messageBytes(s)>2048||Object.keys(s.values).length>8||t.fields&&Object.keys(s.values).some(k=>!t.fields.includes(k))))return null;
  }
  return freeze(structuredClone(data));
 }catch{return null;}
}
/** Honors the validated profile, key binding, issuer degradation and the embedder's islands policy. */
export function requestIslandSpec(client,kind,{islands='auto',islandIssuers=null}={}){
 const issuer=client?.session?.issuer,cap=issuer&&client.capabilitiesFor(issuer),manifest=issuer&&client.capabilities?.manifest(issuer),profile=issuer&&client.capabilities?.declaration(issuer)?.profiles?.[PROFILE],entry=manifest?.features?.['authorization-entry.v1'];
 if(!REQUEST_KINDS.includes(kind)||islands==='off'||islandIssuers&&!islandIssuers.includes(issuer)||!cap?.profile||!cap.entry||!entry?.intents?.includes(kind)||!profile?.bindings?.includes('key-binding.v1')||profile.parts?.request?.version!==1||client.capabilities.degraded(issuer).has('part:request'))return null;
 return Object.freeze({issuer,embedOrigin:cap.embedOrigin,version:1,themeTokens:cap.themeTokens??[]});
}

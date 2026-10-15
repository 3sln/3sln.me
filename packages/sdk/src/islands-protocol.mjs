// Islands channel protocol v1: the wire contract between @3sln/bindle elements and provider islands
// (docs/profiles/components-v1.md §3–§7, Appendix A; docs/architecture/embed-islands.md §4).
// Shared read-only by the SDK elements and the island bundle (apps/embed). Dependency-free, side-effect free.
// Validators return a frozen, normalized copy or null; they never throw and never echo rejected input.
// Provisional: the profile is an unsigned draft; nothing here is production-verified.
import {monogramPattern} from './monogram-pattern.mjs';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

export const PROFILE='https://3sln.me/artefacts/profiles/components/v1';
export const PROTOCOL=freeze([1]);
export const PART_PATTERN=/^[a-z][a-z-]{0,31}$/;
const COMMON_INBOUND=['theme','locale','scheme','props','session','forget'];
/** Part registry v1: versions, inbound types, outbound types (the events contract, profile §5.4) and props schema. */
export const PARTS=freeze({
  avatar:{versions:[1],interactive:false,inbound:COMMON_INBOUND,outbound:['ready'],props:{}},
  'account-switcher':{versions:[1],interactive:true,inbound:[...COMMON_INBOUND,'prepare'],outbound:['ready','flow','code','select','escape','dismiss'],props:{density:['regular','compact'],actions:['use-another','manage','remove']}},
  'sign-in':{versions:[1],interactive:true,inbound:[...COMMON_INBOUND,'prepare'],outbound:['ready','flow','code'],props:{label:['continue','sign-in','sign-up'],variant:['filled','outline']}},
});
export const PART_NAMES=freeze(Object.keys(PARTS));
/** State messages are last-value-wins; session and forget are never rate-limited (profile §5.2). */
export const STATE_TYPES=freeze(['theme','locale','scheme','props','session','prepare']);
export const UNLIMITED_TYPES=freeze(['theme','locale','scheme','props','session','prepare','forget']);
export const FLOW_OUTCOMES=freeze(['completed','canceled','popup-blocked','unavailable']);
export const LIMITS=freeze({init:8192,prepare:8192,code:4096,other:2048,tokens:16,url:2048,lang:35,loginHint:320,uiLocales:4,requests:32,depth:8,ratePerSecond:10,violations:3,violationWindowMs:60000,handshakeMs:3000});
export const AVATAR_BUCKETS=freeze([64,128,256,512]);

// ---- Shell addressing -------------------------------------------------------------------------------------
const NAME=/^bindle-island;v=1;n=([A-Za-z0-9_-]{22});l=([A-Za-z0-9-]{1,35});cs=(light|dark)$/;
/** `#<part>.v<version>` (profile §3) or the bare `#<part>` (= version 1, embed-islands EI-1). Nothing else. */
export function parseFragment(hash){
  if(typeof hash!=='string'||hash.length>48)return null;
  const match=/^#([a-z][a-z-]{0,31})(?:\.v([1-9][0-9]{0,2}))?$/.exec(hash);if(!match||!own(PARTS,match[1]))return null;
  const version=match[2]?Number(match[2]):1;return PARTS[match[1]].versions.includes(version)?freeze({part:match[1],version}):null;
}
export function parseIslandName(name){const match=typeof name==='string'?NAME.exec(name):null;return match&&validLang(match[2])?freeze({nonce:match[1],lang:match[2],colorScheme:match[3]}):null;}
export function formatIslandName({nonce,lang,colorScheme}){const name=`bindle-island;v=1;n=${nonce};l=${lang};cs=${colorScheme}`;if(!parseIslandName(name))throw new TypeError('Invalid island name.');return name;}
export function islandURL(embedOrigin,clientId,part,version=1){if(!own(PARTS,part))throw new TypeError('Unknown part.');return `${embedOrigin}/embed?client=${encodeURIComponent(clientId)}#${part}.v${version}`;}
/** Smallest bucket covering the embedder-set box at the device pixel ratio (embed-islands §6.1). */
export function avatarBucket(width,height,dpr=1){const need=Math.min(width,height)*(Number.isFinite(dpr)&&dpr>0?dpr:1);return AVATAR_BUCKETS.find(size=>size>=need)??AVATAR_BUCKETS.at(-1);}

// ---- Message hygiene --------------------------------------------------------------------------------------
/** Plain structured-clone data only: Object/Array prototypes, primitives, bounded depth (profile §5.2). */
export function isPlainData(value,depth=0){
  if(value===null||['string','boolean'].includes(typeof value))return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||depth>LIMITS.depth)return false;
  const proto=Object.getPrototypeOf(value);
  if(Array.isArray(value)){if(proto!==Array.prototype)return false;for(let i=0;i<value.length;i++)if(!own(value,i)||!isPlainData(value[i],depth+1))return false;return Object.keys(value).length===value.length;}
  if(proto!==Object.prototype||Object.getOwnPropertySymbols(value).length)return false;
  for(const key of Object.keys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!own(descriptor,'value')||!isPlainData(descriptor.value,depth+1))return false;}
  return true;
}
const encoder=new TextEncoder();
export function messageBytes(value){try{return encoder.encode(JSON.stringify(value)).length;}catch{return Infinity;}}
export function sizeLimit(type){return type==='bindle-island-init'?LIMITS.init:type==='prepare'?LIMITS.prepare:type==='code'?LIMITS.code:LIMITS.other;}
/** Length-independent comparison of two ASCII strings of equal expected length. */
export function constantTimeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
const exactKeys=(value,required,optional=[])=>Object.keys(value).every(key=>required.includes(key)||optional.includes(key))&&required.every(key=>own(value,key));
const B64_43=/^[A-Za-z0-9_-]{43}$/;
function validLang(value){return typeof value==='string'&&value.length<=LIMITS.lang&&/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(value);}
const uint32=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
function httpsURL(value,{origin}={}){
  if(typeof value!=='string'||value.length>LIMITS.url)return null;let url;try{url=new URL(value);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==value||/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))return null;
  return origin!==undefined&&url.origin!==origin?null:url;
}
const subjectOf=(value,issuer)=>value===null?null:httpsURL(value,{origin:issuer})?value:undefined;

// ---- Theme tokens (profile §7) ----------------------------------------------------------------------------
export const COLOR_TOKENS=freeze(['surface','surface-raised','text','text-muted','accent','on-accent','border','focus','danger']);
export const THEME_TOKENS=freeze([...COLOR_TOKENS,'radius']);
export const CONTRAST_PAIRS=freeze([['text','surface',4.5],['text-muted','surface',4.5],['text','surface-raised',4.5],['text-muted','surface-raised',4.5],['on-accent','accent',4.5],['danger','surface',4.5],['danger','surface-raised',4.5],['accent','surface',4.5],['accent','surface-raised',4.5],['focus','surface',3],['focus','surface-raised',3],['border','surface',3],['border','surface-raised',3]]);
export const THEME_DEFAULTS=freeze({
  light:{surface:'#ffffff','surface-raised':'#f4f5f7',text:'#1b1d21','text-muted':'#545a63',accent:'#2f5bd3','on-accent':'#ffffff',border:'#7c838d',focus:'#2f5bd3',danger:'#b42318',radius:8},
  dark:{surface:'#17191d','surface-raised':'#22252b',text:'#eef0f3','text-muted':'#b2b8c1',accent:'#8fb0ff','on-accent':'#0e1424',border:'#80878f',focus:'#8fb0ff',danger:'#ff9a8f',radius:8},
});
const channel=value=>{const c=value/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
const luminance=hex=>{const n=Number.parseInt(hex.slice(1),16);return 0.2126*channel(n>>16&255)+0.7152*channel(n>>8&255)+0.0722*channel(n&255);};
export function contrastRatio(a,b){const [x,y]=[luminance(a),luminance(b)].sort((m,n)=>n-m);return (x+0.05)/(y+0.05);}
/** Allowlist + grammar + contrast matrix. A failing pair reverts both members to the defaults. Never trusts the sender. */
export function validateThemeTokens(input,{scheme='light'}={}){
  const tokens={},rejected=new Set(),entries=input&&typeof input==='object'&&!Array.isArray(input)&&isPlainData(input)?Object.entries(input):[];
  if(entries.length>LIMITS.tokens)return freeze({tokens:{},rejected:[]});
  for(const [name,value] of entries){
    if(!THEME_TOKENS.includes(name)){rejected.add(name.slice(0,32));continue;}
    if(name==='radius'){if(Number.isInteger(value)&&value>=0&&value<=16)tokens.radius=value;else rejected.add(name);}
    else if(typeof value==='string'&&/^#[0-9a-f]{6}$/.test(value))tokens[name]=value;else rejected.add(name);
  }
  const defaults=THEME_DEFAULTS[scheme]??THEME_DEFAULTS.light,resolved=name=>tokens[name]??defaults[name],failing=new Set();
  for(const [fore,back,minimum] of CONTRAST_PAIRS)if((own(tokens,fore)||own(tokens,back))&&contrastRatio(resolved(fore),resolved(back))<minimum){failing.add(fore);failing.add(back);}
  for(const name of failing)if(own(tokens,name)){delete tokens[name];rejected.add(name);}
  return freeze({tokens,rejected:[...rejected]});
}

// ---- Inbound (element → island), profile §5.3 -------------------------------------------------------------
function props(part,value,{message=false}={}){
  const schema=PARTS[part].props,base=message?['v','type','seq']:['seq'];
  if(!value||typeof value!=='object'||!exactKeys(value,base,Object.keys(schema))||!uint32(value.seq))return null;
  const out={seq:value.seq};
  for(const [key,allowed] of Object.entries(schema)){
    if(!own(value,key))continue;const field=value[key];
    if(key==='actions'){if(!Array.isArray(field)||field.length>allowed.length||new Set(field).size!==field.length||field.some(item=>!allowed.includes(item)))return null;out.actions=[...field];}
    else if(allowed.includes(field))out[key]=field;else return null;
  }
  return out;
}
function theme(value,{message=false}={}){
  if(!value||typeof value!=='object'||!exactKeys(value,message?['v','type','seq','tokens']:['seq','tokens'])||!uint32(value.seq))return null;
  const tokens=value.tokens;if(!tokens||typeof tokens!=='object'||Array.isArray(tokens)||Object.keys(tokens).length>LIMITS.tokens)return null;
  for(const [name,token] of Object.entries(tokens))if(name.length>32||!(typeof token==='string'&&token.length<=16||Number.isInteger(token)))return null;
  return {seq:value.seq,tokens:{...tokens}};
}
const envelope=(data,type)=>data&&typeof data==='object'&&!Array.isArray(data)&&data.v===1&&data.type===type&&isPlainData(data)&&messageBytes(data)<=sizeLimit(type);
/** The window init message. The caller compares `nonce` (constant time) and origins; this checks shape and part. */
export function validateInit(data,{part,version,nonce}){
  if(!envelope(data,'bindle-island-init')||!exactKeys(data,['v','type','nonce','part','version','theme','locale','colorScheme','props']))return null;
  if(data.part!==part||data.version!==version||!own(PARTS,part)||typeof data.nonce!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(data.nonce)||!constantTimeEqual(data.nonce,nonce))return null;
  const t=theme(data.theme),p=props(part,data.props);
  if(!t||!p||!validLang(data.locale)||!['light','dark'].includes(data.colorScheme))return null;
  return freeze({part,version,theme:t,locale:data.locale,colorScheme:data.colorScheme,props:p});
}
/** Port messages. `issuer` bounds subjects; `origins` (allowed parent origins) bounds `prepare.redirectUri`. */
export function validateInbound(data,{part,issuer,origins=[]}){
  if(!data||typeof data!=='object'||typeof data.type!=='string'||!own(PARTS,part)||!PARTS[part].inbound.includes(data.type)||!envelope(data,data.type))return null;
  const type=data.type;
  switch(type){
    case 'theme':{const t=theme(data,{message:true});return t&&freeze({type,...t});}
    case 'props':{const p=props(part,data,{message:true});return p&&freeze({type,props:p});}
    case 'locale':return exactKeys(data,['v','type','lang'])&&validLang(data.lang)?freeze({type,lang:data.lang}):null;
    case 'scheme':return exactKeys(data,['v','type','colorScheme'])&&['light','dark'].includes(data.colorScheme)?freeze({type,colorScheme:data.colorScheme}):null;
    case 'session':{if(!exactKeys(data,['v','type','subject']))return null;const subject=subjectOf(data.subject,issuer);return subject===undefined?null:freeze({type,subject});}
    case 'forget':{if(!exactKeys(data,['v','type'],['subject']))return null;if(!own(data,'subject'))return freeze({type});const subject=subjectOf(data.subject,issuer);return subject?freeze({type,subject}):null;}
    case 'prepare':{
      if(!exactKeys(data,['v','type','redirectUri','challenge','state','requests'],['loginHint','uiLocales','colorScheme','dpopJkt']))return null;
      const redirect=httpsURL(data.redirectUri);if(!redirect||!origins.includes(redirect.origin)||!B64_43.test(data.challenge)||!B64_43.test(data.state))return null;
      if(!Array.isArray(data.requests)||data.requests.length>LIMITS.requests||data.requests.some(item=>!item||typeof item!=='object'||Array.isArray(item)))return null;
      if(own(data,'loginHint')&&(typeof data.loginHint!=='string'||!data.loginHint||data.loginHint.length>LIMITS.loginHint))return null;
      if(own(data,'uiLocales')&&(!Array.isArray(data.uiLocales)||data.uiLocales.length>LIMITS.uiLocales||!data.uiLocales.every(validLang)))return null;
      if(own(data,'colorScheme')&&!['light','dark'].includes(data.colorScheme)||own(data,'dpopJkt')&&!B64_43.test(data.dpopJkt))return null;
      const {v,type:_,...inputs}=data;return freeze({type,...structuredClone(inputs)});
    }
  }
  return null;
}

// ---- Outbound (island → element), profile §5.4 ------------------------------------------------------------
export function readyMessage({part,version,issuer}){return freeze({v:1,type:'ready',part,version,protocol:[...PROTOCOL],issuer});}
/** Exact per-part events contract. Islands run it before posting (entitlement shape); elements run it on receipt. */
export function validateOutbound(data,{part,version,issuer}){
  if(!data||typeof data!=='object'||typeof data.type!=='string'||!own(PARTS,part)||!PARTS[part].outbound.includes(data.type)||!envelope(data,data.type))return null;
  const type=data.type;
  switch(type){
    case 'ready':return exactKeys(data,['v','type','part','version','protocol','issuer'])&&data.part===part&&data.version===version&&Array.isArray(data.protocol)&&data.protocol.length>=1&&data.protocol.length<=8&&data.protocol.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(data.protocol).size===data.protocol.length&&data.issuer===issuer?freeze(structuredClone(data)):null;
    case 'flow':if(data.phase==='started')return exactKeys(data,['v','type','phase'])?freeze({v:1,type,phase:'started'}):null;return data.phase==='ended'&&exactKeys(data,['v','type','phase','outcome'])&&FLOW_OUTCOMES.includes(data.outcome)?freeze({v:1,type,phase:'ended',outcome:data.outcome}):null;
    case 'code':return exactKeys(data,['v','type','code','state','iss'])&&typeof data.code==='string'&&/^[\x21-\x7e]{1,2048}$/.test(data.code)&&B64_43.test(data.state)&&data.iss===issuer?freeze({v:1,type,code:data.code,state:data.state,iss:data.iss}):null;
    case 'select':return exactKeys(data,['v','type','subject'])&&subjectOf(data.subject,issuer)?freeze({v:1,type,subject:data.subject}):null;
    case 'escape':case 'dismiss':return exactKeys(data,['v','type'])?freeze({v:1,type}):null;
  }
  return null;
}

// ---- Monogram (profile Appendix A) ------------------------------------------------------------------------
// The pattern lives in its own module so the elements' first render (which re-exports it) never pulls in this file.
export {monogramPattern};
const TONES=freeze({light:{background:[0.93,0.03],cells:[0.40,0.065]},dark:{background:[0.36,0.06],cells:[0.93,0.03]}});
/** OKLCH → opaque sRGB hex (gamut-clamped), so islands and elements paint identical bytes. */
export function oklchToHex(l,c,h){
  const a=c*Math.cos(h*Math.PI/180),b=c*Math.sin(h*Math.PI/180);
  const L=(l+0.3963377774*a+0.2158037573*b)**3,M=(l-0.1055613458*a-0.0638541728*b)**3,S=(l-0.0894841775*a-1.2914855480*b)**3;
  const linear=[4.0767416621*L-3.3077115913*M+0.2309699292*S,-1.2684380046*L+2.6097574011*M-0.3413193965*S,-0.0041960863*L-0.7034186147*M+1.7076147010*S];
  return '#'+linear.map(v=>{const x=Math.min(1,Math.max(0,v)),g=x<=0.0031308?12.92*x:1.055*x**(1/2.4)-0.055;return Math.round(g*255).toString(16).padStart(2,'0');}).join('');
}
export function monogramColors(subject,scheme='light'){const pattern=monogramPattern(subject);if(!pattern)return null;const tone=TONES[scheme]??TONES.light;return freeze({background:oklchToHex(...tone.background,pattern.hue),foreground:oklchToHex(...tone.cells,pattern.hue)});}

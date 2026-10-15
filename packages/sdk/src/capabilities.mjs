// Provider declarations and per-feature capabilities (components-profile decision
// note §4–§5, protocol §2). Pure and side-effect free: no window, storage or
// network. identity.mjs feeds it validated manifests; elements read only the
// frozen capability set, never the manifest.
//
// Provisional: protocol §2 `features`/`profiles` and the components profile are
// unsigned drafts. `authorization-entry.v1` is reserved until its wire text is
// published; no deployed provider declares any of this yet.
import {PROFILE as COMPONENTS_V1,PARTS,THEME_TOKENS} from './islands-protocol.mjs';

export {COMPONENTS_V1};
export const authorizationIntents=Object.freeze(['login','select-account','reauthenticate','end-session']);
// Feature versions this SDK implements; a provider may declare several and the highest common one wins.
export const implementedFeatures=Object.freeze({'authorization-entry':[1],fedcm:[1],intents:[1],'client-id-metadata':[1]});
export const declarationLimits=Object.freeze({features:32,featureBytes:4096,profiles:8,profileBytes:8192,cacheDefault:300000,cacheMax:3600000});
export const credentialBindings=Object.freeze(['key-binding.v1']);
const featureKey=/^([a-z][a-z0-9-]{0,31})\.v([1-9][0-9]{0,2})$/;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const coded=(message,code)=>Object.assign(new Error(message),{code});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>{try{return new TextEncoder().encode(JSON.stringify(value)).length;}catch{return Infinity;}};
const strings=(value,max)=>Array.isArray(value)&&value.length>0&&value.length<=max&&value.every(item=>typeof item==='string'&&item.length<=64);
// An endpoint on the issuer origin with no credentials or fragment; null otherwise.
export function issuerURL(value,issuer){
  if(typeof value!=='string'||value.length>2048)return null;let url;try{url=new URL(value);}catch{return null;}
  return url.origin===issuer&&!url.username&&!url.password&&!url.hash?url.href:null;
}

// Conformance floor (protocol §2): fails closed with `unsupported-provider`, never a fallback.
export function checkFloor(manifest,issuer){
  const fail=message=>{throw coded(message,'unsupported-provider');};
  if(!plain(manifest)||manifest.version!=='0'||manifest.issuer!==issuer)fail('Unsupported manifest version or mismatched issuer.');
  if(!Array.isArray(manifest.login_presentation)||manifest.login_presentation.length>8||!manifest.login_presentation.includes('redirect'))fail('Provider must support redirect login.');
  for(const key of ['authorization_endpoint','token_endpoint','rpc_endpoint','jwks_uri','authorization_request_endpoint'])if(!issuerURL(manifest[key],issuer))fail(`Missing or foreign provider endpoint: ${key}.`);
  let contract;try{contract=new URL(manifest.preferences_contract);}catch{fail('Missing preferences contract.');}
  if(contract.protocol!=='https:'||contract.username||contract.password||contract.hash)fail('Invalid preferences contract.');
}

const featureReaders={
  // Absent or invalid intents make the feature absent (never "all intents"); unknown intent values are ignored.
  'authorization-entry':(value,issuer)=>{const endpoint=issuerURL(value.endpoint,issuer);if(!endpoint||!strings(value.intents,16))return null;const intents=authorizationIntents.filter(intent=>value.intents.includes(intent));return intents.length?{endpoint,intents}:null;},
  fedcm:(value,issuer)=>{const configUrl=issuerURL(value.config_url,issuer);return configUrl?{configUrl}:null;},
  intents:(value,issuer)=>{const loginEndpoint=issuerURL(value.login_endpoint,issuer);return loginEndpoint&&strings(value.intents,16)?{intents:[...new Set(value.intents)],loginEndpoint}:null;},
  'client-id-metadata':()=>({}),
};

// Components profile §2 member validation. Returns null when the declaration must be ignored.
export function readComponentsProfile(value,issuer,{embedderOrigin}={}){
  if(!plain(value)||bytes(value)>declarationLimits.profileBytes)return null;
  let embed;try{embed=new URL(value.embed_origin);}catch{return null;}
  if(embed.origin!==value.embed_origin||embed.protocol!=='https:'||/^\[|^\d+(?:\.\d+){3}$/.test(embed.hostname)||embed.origin===issuer||embed.origin===embedderOrigin)return null;
  const positive=list=>Array.isArray(list)&&list.length>=1&&list.length<=8&&list.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(list).size===list.length;
  if(!positive(value.protocol)||!value.protocol.includes(1)||!plain(value.parts)||Object.keys(value.parts).length>16)return null;
  const parts={};
  for(const [name,part] of Object.entries(value.parts)){
    if(!Object.hasOwn(PARTS,name)||!plain(part)||!positive(part.versions)||part.fedcm!==undefined&&typeof part.fedcm!=='boolean')continue;
    const version=Math.max(...part.versions.filter(n=>PARTS[name].versions.includes(n)),0);
    if(version)parts[name]={version,fedcm:part.fedcm===true};
  }
  const list=key=>Array.isArray(value[key])?value[key].filter(item=>typeof item==='string'):[];
  const manageUrl=value.manage_url===undefined?null:issuerURL(value.manage_url,issuer);
  return {embedOrigin:embed.origin,parts,themeTokens:THEME_TOKENS.filter(token=>list('theme_tokens').includes(token)),bindings:credentialBindings.filter(binding=>list('credential_binding').includes(binding)),...manageUrl?{manageUrl}:{}};
}

// Normalized, frozen declaration. Only required members fail closed (checkFloor);
// every optional member, feature and profile is validated independently and an
// invalid one is treated as absent. Unknown keys are ignored.
export function readDeclaration(manifest,issuer,{embedderOrigin}={}){
  checkFloor(manifest,issuer);
  const warnings=[],features={},profiles={};
  const rawFeatures=manifest.features,rawProfiles=manifest.profiles;
  if(rawFeatures!==undefined&&(!plain(rawFeatures)||Object.keys(rawFeatures).length>declarationLimits.features))warnings.push('features');
  else for(const [key,value] of Object.entries(rawFeatures??{})){
    const match=featureKey.exec(key),name=match?.[1],version=Number(match?.[2]);
    if(!match||!implementedFeatures[name]?.includes(version))continue;
    const read=plain(value)&&bytes(value)<=declarationLimits.featureBytes?featureReaders[name](value,issuer):null;
    if(!read){warnings.push(key);continue;}
    if(!features[name]||features[name].version<version)features[name]={version,...read};
  }
  if(rawProfiles!==undefined&&(!plain(rawProfiles)||Object.keys(rawProfiles).length>declarationLimits.profiles))warnings.push('profiles');
  else for(const [uri,value] of Object.entries(rawProfiles??{})){
    let url;try{url=new URL(uri);}catch{continue;}
    if(url.protocol!=='https:'||url.href!==uri)continue;
    if(uri===COMPONENTS_V1){const components=readComponentsProfile(value,issuer,{embedderOrigin});if(components)profiles[uri]=components;else warnings.push(uri);}
  }
  const algs=Array.isArray(manifest.dpop_signing_alg_values_supported)?manifest.dpop_signing_alg_values_supported:[];
  const grants=Array.isArray(manifest.grant_types_supported)?manifest.grant_types_supported:[];
  const revocationEndpoint=manifest.revocation_endpoint===undefined?null:issuerURL(manifest.revocation_endpoint,issuer);
  if(manifest.revocation_endpoint!==undefined&&!revocationEndpoint)warnings.push('revocation_endpoint');
  return freeze({
    issuer,authorizationEndpoint:manifest.authorization_endpoint,tokenEndpoint:manifest.token_endpoint,rpcEndpoint:manifest.rpc_endpoint,requestEndpoint:manifest.authorization_request_endpoint,preferencesContract:manifest.preferences_contract,
    loginPresentation:['redirect','popup'].filter(value=>manifest.login_presentation.includes(value)),
    ...revocationEndpoint?{revocationEndpoint}:{},dpop:algs.includes('ES256'),refresh:grants.includes('refresh_token'),
    features,profiles,warnings,
  });
}

// Capability set (decision note §5): a pure function of the declaration, the
// runtime degradations of that issuer and the embedder's island policy.
export function computeCapabilities(declaration,{degraded=new Set(),defaultIssuer=null,islands='auto',islandIssuers=null,identityCredential=!!globalThis.IdentityCredential}={}){
  if(!declaration)return null;
  const issuer=declaration.issuer,off=key=>degraded.has(key);
  const entry=!off('authorization-entry')&&declaration.features['authorization-entry']||null,intents=entry?entry.intents:[];
  const fedcm=!off('fedcm')&&!!declaration.features.fedcm&&!!entry&&identityCredential;
  const policy=islands!=='off'&&(!islandIssuers||islandIssuers.includes(issuer));
  const components=!off('profile')&&policy&&declaration.profiles[COMPONENTS_V1]||null;
  const identityless=intents.includes('login'),bound=!!components?.bindings.includes('key-binding.v1');
  const delegate=issuer===defaultIssuer||!!islandIssuers?.includes(issuer);
  const part=(name,ok)=>{const value=components?.parts[name];return value&&ok&&!off(`part:${name}`)?Object.freeze({version:value.version,fedcm:value.fedcm&&fedcm&&delegate}):null;};
  return freeze({
    issuer,supported:true,entry:!!entry,intents:[...intents],
    login:true,identityless,selectAccount:intents.includes('select-account'),reauthenticate:intents.includes('reauthenticate'),endSession:intents.includes('end-session'),
    popup:!off('popup')&&declaration.loginPresentation.includes('popup'),fedcm,
    revoke:!!declaration.revocationEndpoint,
    // DPoP needs the entry (it carries dpopJkt) and a refresh grant worth binding.
    dpop:!off('dpop')&&declaration.dpop&&!!entry&&declaration.refresh,refresh:declaration.refresh,
    clientIdMetadata:!!declaration.features['client-id-metadata'],
    intentLinks:declaration.features.intents?[...declaration.features.intents.intents]:[],
    manageUrl:components?.manageUrl??declaration.profiles[COMPONENTS_V1]?.manageUrl??issuer+'/',
    profile:!!components,embedOrigin:components?.embedOrigin??null,themeTokens:components?[...components.themeTokens]:[],
    islands:{avatar:part('avatar',bound),switcher:part('account-switcher',bound&&identityless),signIn:part('sign-in',identityless)},
  });
}

// Runtime failure codes that show a declared capability is not implemented.
export const notImplemented=status=>[404,405,501].includes(status);
// HTTP freshness, capped at one hour; five minutes by default (decision note §4).
export function freshness(response){
  const control=response?.headers?.get?.('cache-control')??'';
  if(/\b(?:no-store|no-cache)\b/i.test(control))return 0;
  const age=/\bmax-age=(\d{1,9})\b/i.exec(control);
  return age?Math.min(Number(age[1])*1000,declarationLimits.cacheMax):declarationLimits.cacheDefault;
}

// Per-document declaration cache and degradation set, keyed by issuer origin.
// Degradations never persist, never cross issuers and never reverse.
export class CapabilityStore {
  #declarations=new Map();#degraded=new Map();#listeners=new Set();
  constructor({clock=Date.now}={}){this.clock=clock;}
  // `manifest` is the floor-checked manifest itself (deep-frozen), kept for consumers of raw members.
  remember(declaration,lifetime=declarationLimits.cacheDefault,manifest=null){
    const previous=this.#declarations.get(declaration.issuer)?.declaration;
    this.#declarations.set(declaration.issuer,{declaration,manifest:freeze(manifest),expiresAt:this.clock()+Math.min(Math.max(lifetime,0),declarationLimits.cacheMax)});
    if(JSON.stringify(previous)!==JSON.stringify(declaration))this.#notify(declaration.issuer);
    return declaration;
  }
  // Fresh declarations only; `stale:true` also returns an expired one (for synchronous UI decisions).
  declaration(issuer,{stale=false}={}){const entry=this.#declarations.get(issuer);return entry&&(stale||entry.expiresAt>this.clock())?entry.declaration:null;}
  manifest(issuer){const entry=this.#declarations.get(issuer);return entry&&entry.expiresAt>this.clock()?entry.manifest:null;}
  degraded(issuer){return new Set(this.#degraded.get(issuer)??[]);}
  degrade(issuer,key){
    const set=this.#degraded.get(issuer)??new Set();if(set.has(key))return;
    set.add(key);this.#degraded.set(issuer,set);this.#notify(issuer);
  }
  capabilities(issuer,options={}){return computeCapabilities(this.declaration(issuer,{stale:true}),{...options,degraded:this.degraded(issuer)});}
  subscribe(listener){this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
  #notify(issuer){for(const listener of this.#listeners)try{listener(issuer);}catch{}}
}

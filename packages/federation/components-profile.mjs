// 3sln.me components profile (provider-operated components: frame, islands, key-bound embed credentials). It is a
// 3sln.me-defined sub-spec, not part of the Bindle protocol (docs/profiles/components-v1.md). This module is the
// only place that knows the declaration members: logic reads configured values through componentsProfile() and
// advertises through componentsDeclaration(). Origins are always configured per instance.
export const COMPONENTS_PROFILE='https://3sln.me/artefacts/profiles/components/v1';
export const COMPONENTS_PROTOCOL=[1];
// Parts the islands shell implements (profile §2, SDK islands-protocol PARTS). FedCM is not implemented, so no part
// declares it; `key-binding.v1` is the embed credential binding implemented by the federation service. Theme tokens
// stay undeclared (islands use provider defaults) until the shell's token handling has evidence.
export const COMPONENTS_PARTS={avatar:{versions:[1]},'account-switcher':{versions:[1]},'sign-in':{versions:[1]}};
/** Configured values for this provider instance, or null when components are not offered. Profile §2: a dedicated
 * HTTPS origin without an IP literal; loopback http/IP origins are accepted only under LOCAL_DEVELOPMENT. A
 * misconfigured value disables components (no embed routes, no declaration) instead of failing every request. */
export function componentsProfile(config){
 const embedOrigin=config?.EMBED_ORIGIN;if(config?.FEDERATION_ENTRY_ENABLED!=='true'||!embedOrigin)return null;
 let url;try{url=new URL(embedOrigin);}catch{return null;}
 const local=config.LOCAL_DEVELOPMENT==='true',ip=/^\[|^\d+(?:\.\d+){3}$/.test(url.hostname);
 if(url.origin!==embedOrigin||url.origin===config.APP_ORIGIN||!local&&(url.protocol!=='https:'||ip)||local&&!['https:','http:'].includes(url.protocol))return null;
 return {profile:COMPONENTS_PROFILE,embedOrigin};
}
/** Profile §2 declaration under the core `profiles` container; `{}` when components are not offered. */
export function componentsDeclaration(profile,{manageUrl}={}){
 if(!profile)return {};
 return {profiles:{[profile.profile]:{embed_origin:profile.embedOrigin,protocol:[...COMPONENTS_PROTOCOL],parts:structuredClone(COMPONENTS_PARTS),credential_binding:['key-binding.v1'],...manageUrl?{manage_url:manageUrl}:{}}}};
}

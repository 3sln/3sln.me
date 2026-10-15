// The single Trusted Types policy of the embed origin (embed-islands §3.1, EIR-2). It defines only
// createScriptURL, which returns exact allowlisted same-origin paths and throws otherwise. createHTML and
// createScript stay undefined, so HTML and script sinks keep throwing under
// `require-trusted-types-for 'script'; trusted-types bindle-embed`.
export const POLICY_NAME='bindle-embed';
const SCRIPT_PATH=/^\/embed\/(?:assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.m?js|sw\.js)$/;
export const allowedScriptPath=path=>typeof path==='string'&&SCRIPT_PATH.test(path)&&!path.includes('..');
export function createScriptURLPolicy(paths,{tt=globalThis.trustedTypes,origin=globalThis.location?.origin}={}){
  const allowed=Object.freeze(paths.filter(allowedScriptPath));
  const check=value=>{const url=new URL(String(value),origin);if(url.origin!==origin||url.search||url.hash||!allowed.includes(url.pathname))throw new TypeError('Script URL is not allowed.');return url.href;};
  const policy=tt?.createPolicy?tt.createPolicy(POLICY_NAME,{createScriptURL:check}):null;
  return Object.freeze({allowed,scriptURL:value=>policy?policy.createScriptURL(value):check(value)});
}

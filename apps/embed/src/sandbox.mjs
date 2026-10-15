// Sandbox probe (adaptive-app-sign-in §10.1, slice A5). Touches no storage, so it may run before the handshake.
// `document.domain = document.domain` throws SecurityError in any sandboxed document (the sandboxed
// document.domain flag has no allow- keyword), even with allow-same-origin, where `origin` stays non-null
// (COOP spike, Chromium 156 / Firefox 157). An opaque origin also means sandboxed. Usability guard only:
// the attestation argument never depends on it. The profile's target sandbox token set is not yet accepted
// as normal (no browser evidence), so any sandbox degrades.
export function probeSandbox({doc=globalThis.document,origin=globalThis.origin}={}){
  if(origin==='null')return {sandboxed:true};
  try{doc.domain=doc.domain;}catch(error){return {sandboxed:error?.name==='SecurityError'};}
  return {sandboxed:false};
}

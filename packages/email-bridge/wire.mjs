// The few wire helpers the provider bridge shares with the messaging spec (bindlebox.md §9). Core must not import
// BindleBox packages (extraction import boundary), so these come from core modules or are restated here and pinned
// against the BindleBox receiver by tests/email-bridge-handoff.test.mjs.
import {jcs} from '../links/author-proof.mjs';
import {PUBLIC_INTAKE_SLOT} from '../links/types.mjs';
export {jcs};
export const INTAKE_SLOT=PUBLIC_INTAKE_SLOT,INTAKE_CONTRACT='https://spec.bindle.example/contracts/public-intake/v1';
export const base64url=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
export const decodedLength=value=>Math.floor(value.length*3/4);
export const sha256=async value=>base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)));
/** normalizedDigest: SHA-256 over JCS of the delivered `message` object (spec §9, the receiver's reading). */
export const intakeDigest=message=>sha256(jcs(message));

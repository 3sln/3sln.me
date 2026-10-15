// The islands shell document (embed islands §3.1; components profile §3). scripts/build-assets.mjs emits the template
// `/embed/shell.html` with hashed asset URLs and a static import map, plus `/embed/shell.json` describing the build
// (worker URL, service worker URL, import-map hash). Per-client values (issuer, client, parent origins, parts) exist only
// at request time, so the server fills `{{CONFIG}}` here; build-assets uses the same function to prove the template.
import {COMPONENTS_PARTS} from './components-profile.mjs';
export const SHELL_TEMPLATE='/embed/shell.html',SHELL_BUILD='/embed/shell.json',CONFIG_SLOT='{{CONFIG}}';
const SCRIPT_PATH=/^\/embed\/(?:assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.m?js|sw\.js)$/,HASH=/^sha256-[A-Za-z0-9+/]{43}=$/;

/** Validates the build description written by build-assets; null when it is missing or malformed. */
export function shellBuild(value){
 if(!value||typeof value!=='object'||value.v!==1||!SCRIPT_PATH.test(value.worker??'')||value.worker.includes('..')||value.sw!=='/embed/sw.js'||!Array.isArray(value.scripts)||!value.scripts.length||value.scripts.length>4||!value.scripts.every(hash=>HASH.test(hash)))return null;
 return Object.freeze({worker:value.worker,sw:value.sw,scripts:Object.freeze([...value.scripts])});
}
/** The non-executable per-client config block read by apps/embed/src/boot.mjs `readConfig`. */
export function shellConfig({issuer,clientId,origins,parts=Object.keys(COMPONENTS_PARTS),build}){
 return {v:1,issuer,clientId,origins:[...origins],parts:[...parts],worker:build.worker,sw:build.sw};
}
/** Fills the single config slot. `<` is escaped so no value can close the `<script type="application/json">` block. */
export function fillShell(template,config){
 if(typeof template!=='string'||template.split(CONFIG_SLOT).length!==2)throw new TypeError('The islands shell needs exactly one config slot.');
 const json=JSON.stringify(config).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
 return template.replace(CONFIG_SLOT,()=>json);
}
/** Shell CSP (embed islands §3.1, EIR-2): same-origin script plus the hashed static import map, Trusted Types with the
 * single `bindle-embed` script-URL policy, the issuer for entry creation, and the client's parent origins. */
export function shellPolicy({issuer,ancestors,scripts}){
 return `default-src 'none'; script-src 'self' ${scripts.map(hash=>`'${hash}'`).join(' ')}; style-src 'self'; img-src blob:; connect-src 'self' ${issuer}; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors.join(' ')}; require-trusted-types-for 'script'; trusted-types bindle-embed`;
}

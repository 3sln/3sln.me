// Shared pieces for the Bindle custom elements. Nothing here touches window,
// document, crypto or storage at module top level, so importing under SSR
// (Node, Workers) is safe. Classes extend HTMLElement only where it exists.
import {h} from '../../../../vendor/dodo/index.js';
import {css,reconcileShadow} from '../../../../vendor/dodo/style.js';
import {createSdkLocalization} from '../../../i18n/sdk-catalogue.mjs';

export {h,reconcileShadow};
export const ElementBase=globalThis.HTMLElement??class {};
export const sessionContext='bindle-session';
// Internal entry point that records which element started a flow, so only that
// element renders the flow's notices. Public methods remain the API.
export const startFlow=Symbol('bindle.startFlow');
// Every defined session tag (one per prefix), for late-upgrade discovery.
export const registry={sessionTags:new Set(['bindle-session'])};
const sessionDefined=()=>Promise.race([...registry.sessionTags].map(tag=>globalThis.customElements.whenDefined(tag)));

// Attribute maps for dodo: drop null/undefined/false, render true as present.
export const attrs=map=>{const result={};for(const [key,value] of Object.entries(map))if(value!==undefined&&value!==null&&value!==false)result[key]=value===true?'':String(value);return result;};
const realm=node=>node.ownerDocument?.defaultView??globalThis;
export const emit=(target,type,detail)=>target.dispatchEvent(new (realm(target).CustomEvent)(type,{detail,bubbles:true,composed:true}));

export function localeFor(element){
  const own=element.getAttribute('lang')||element.closest?.('[lang]')?.getAttribute('lang');
  return own||globalThis.navigator?.language||'en';
}
export function localize(element){return createSdkLocalization({locale:localeFor(element)});}
export function themeFor(element,session){
  const value=element.getAttribute('theme')??session?.getAttribute?.('theme')??'auto';
  return ['light','dark'].includes(value)?value:'auto';
}
// Effective scheme (decision note §7.1 step 4): the theme attribute (own, then the
// session's); else the luminance of an embedder-set --bindle-surface (dark below
// 0.18); else the embedder's used color-scheme; else prefers-color-scheme. The
// returned class drives the token defaults and `colorScheme` is set on the shadow
// root container, so light-dark() tones follow live changes without script.
const channel=value=>{const c=value/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
function surfaceScheme(element){
  const view=element.ownerDocument?.defaultView,raw=view?.getComputedStyle?.(element)?.getPropertyValue?.('--bindle-surface')?.trim();if(!raw)return null;
  let match=/^#([0-9a-f]{6})$/i.exec(raw),rgb;
  if(match){const n=Number.parseInt(match[1],16);rgb=[n>>16&255,n>>8&255,n&255];}
  else{const probe=element.ownerDocument.createElement('span');probe.style.color=raw;(element.shadowRoot??element).append(probe);const used=view.getComputedStyle(probe).color;probe.remove();match=/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(used);rgb=match?.slice(1,4).map(Number);}
  if(!rgb)return null;
  return 0.2126*channel(rgb[0])+0.7152*channel(rgb[1])+0.0722*channel(rgb[2])<0.18?'dark':'light';
}
export function schemeFor(element,session){
  let theme=themeFor(element,session);
  if(theme==='auto')theme=surfaceScheme(element)??'auto';
  if(theme!=='auto')return {theme,colorScheme:theme};
  const inherited=element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.colorScheme;
  // An embedder color-scheme is inherited as is; an unset one follows the OS preference.
  return {theme,colorScheme:!inherited||inherited==='normal'?'light dark':undefined};
}
// Re-renders an element when the OS scheme changes (embedder color-scheme changes apply through CSS).
// Embedder color-scheme/--bindle-surface changes made through the root, body or
// host attributes (class, style, data-*) are observed too; other changes call
// element.refreshTheme().
export function watchScheme(element,rerender){
  const view=element.ownerDocument?.defaultView,media=view?.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change',rerender);
  let observer=null;
  try{observer=new view.MutationObserver(()=>rerender());for(const node of [element.ownerDocument.documentElement,element.ownerDocument.body,element].filter(Boolean))observer.observe(node,{attributes:true,attributeFilter:['class','style','data-theme','color-scheme']});}catch{observer=null;}
  return ()=>{media?.removeEventListener?.('change',rerender);observer?.disconnect();};
}
// Derived element events dispatch in a microtask after the controller event that
// caused them, so document listeners always see bindle-session-change first.
export const emitLater=(target,type,detail)=>queueMicrotask(()=>emit(target,type,Object.freeze(detail)));

// Island hook (components profile; embed-islands §8.2, §12.4). Mounting belongs
// to the islands slice (elements/islands.mjs, loaded only for declaring
// providers). Elements decide only whether a part may mount: the capability set
// must list it, which already applies the embedder's islands="auto|off" and
// island-issuers policy and the profile's cross-checks. Until the mounter reports
// 'live', the standard composition is what the user sees.
export function islandPart(session,part,capabilities=session?.capabilities){
  const name={avatar:'avatar','account-switcher':'switcher','sign-in':'signIn'}[part];
  const value=capabilities?.islands?.[name];
  return value?Object.freeze({part,issuer:capabilities.issuer,embedOrigin:capabilities.embedOrigin,version:value.version,fedcm:value.fedcm,themeTokens:capabilities.themeTokens}):null;
}
export async function mountIsland(element,{part,container,session,onState,capabilities}){
  const spec=islandPart(session,part,capabilities);if(!spec||!container)return null;
  try{const module=await import('./islands.mjs');return await module.mountIsland({element,container,session,onState,...spec});}catch{return null;}
}

// Context protocol (Web Components Community Group): descendants ask for the
// nearest <bindle-session>, crossing shadow roots via a composed event. An
// explicit controller="<id>" attribute links to a session anywhere in the root.
export function requestSession(element,callback){
  const id=element.getAttribute('controller');
  if(id){
    const find=()=>element.getRootNode?.().getElementById?.(id)??globalThis.document?.getElementById(id);
    const found=find();
    if(found?.ready)return found.ready.then(()=>callback(found));
    if(globalThis.customElements)sessionDefined().then(()=>{const later=find();later?.ready?.then(()=>callback(later));});
    return;
  }
  let answered=false;
  const ask=()=>{
    const event=new (realm(element).Event)('context-request',{bubbles:true,composed:true});
    Object.assign(event,{context:sessionContext,contextTarget:element,subscribe:false,callback:value=>{if(!answered){answered=true;callback(value);}}});
    element.dispatchEvent(event);
  };
  ask();
  // The session element may upgrade after its descendants; ask again once it is defined.
  if(!answered&&globalThis.customElements)sessionDefined().then(()=>queueMicrotask(()=>{if(!answered&&element.isConnected)ask();}));
}

// Neutral defaults (no 3sln palette) meeting the §8.5 contrast rules in both schemes.
// Embedders override with the public --bindle-* custom properties or ::part().
const light='--_surface:var(--bindle-surface,#ffffff);--_raised:var(--bindle-surface-raised,#f4f5f7);--_text:var(--bindle-text,#1b1d21);--_muted:var(--bindle-text-muted,#545a63);--_accent:var(--bindle-accent,#2f5bd3);--_on-accent:var(--bindle-on-accent,#ffffff);--_border:var(--bindle-border,#7c838d);--_focus:var(--bindle-focus,#2f5bd3);--_danger:var(--bindle-danger,#b42318);--_mono-l:38%;';
const dark='--_surface:var(--bindle-surface,#17191d);--_raised:var(--bindle-surface-raised,#22252b);--_text:var(--bindle-text,#eef0f3);--_muted:var(--bindle-text-muted,#b2b8c1);--_accent:var(--bindle-accent,#8fb0ff);--_on-accent:var(--bindle-on-accent,#0e1424);--_border:var(--bindle-border,#80878f);--_focus:var(--bindle-focus,#8fb0ff);--_danger:var(--bindle-danger,#ff9a8f);--_mono-l:72%;';
export const baseStyles=view=>css.in(view)`
:host{display:block;font:inherit;font-size:calc(1em * var(--bindle-font-scale,1));${light}}
:host([hidden]){display:none}
/* Text that sits on the embedder's own background inherits the embedder's color. */
.root{color:var(--bindle-text,inherit)}
.root.dark{${dark}}
@media (prefers-color-scheme:dark){.root.auto{${dark}}}
.root{--_radius:calc(var(--bindle-radius,8) * 1px)}
.visually-hidden{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
button,.button{font:inherit;min-block-size:44px;min-inline-size:44px;padding-block:.55em;padding-inline:1em;border-radius:var(--_radius);border:1px solid var(--_border);background:var(--_surface);color:var(--_text);cursor:pointer}
button.primary{background:var(--_accent);color:var(--_on-accent);border-color:var(--_accent)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--_focus);outline-offset:2px}
button:disabled{cursor:default;opacity:.7}
.notice{margin-block-start:.75em;padding:.75em;border:1px solid var(--_border);border-radius:var(--_radius);background:var(--_raised);color:var(--_text)}
.notice p{margin:0 0 .5em}
.notice .actions{display:flex;flex-wrap:wrap;gap:.5em}
.status{color:var(--bindle-text-muted,color-mix(in srgb,currentColor 78%,transparent));margin:.5em 0 0;overflow-wrap:anywhere}
.error{color:var(--_danger);margin:.5em 0 0;overflow-wrap:anywhere}
.error:empty,.status:empty{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (forced-colors:active){button,.button,.notice{border-color:ButtonText;background:ButtonFace;color:ButtonText}button.primary{background:Highlight;color:HighlightText}.error{color:Mark}button:focus-visible,a:focus-visible,input:focus-visible{outline-color:Highlight}}
`;

// Flow notices rendered only by the element that started the flow (§6.3).
export function flowNotice(flow,t,session){
  if(!flow||!session)return null;
  const host=flow.host;
  const action=(label,run,primary)=>h('button',label).props({type:'button'}).classes(primary&&'primary').on({click:run});
  if(flow.phase==='blocked')return h('div',
    h('p',t('Your browser blocked the sign-in window.')),
    h('div',action(t('Try again'),()=>session.retry(),true),action(t('Continue in this tab'),()=>session.continueInTab())).classes('actions'),
  ).classes('notice').attrs({role:'alert',part:'notice'});
  if(flow.phase==='waiting'&&flow.presentation==='popup')return h('div',
    h('p',host?t('Waiting for {host}…',{host}):t('Waiting for your provider…')),
    h('div',
      flow.lingering&&action(t('Show window'),()=>session.showWindow()),
      // Always visible in popup mode: embedded webviews may never show the window.
      action(t('Continue in this tab'),()=>session.continueInTab()),
      flow.lingering&&action(t('Cancel'),()=>session.cancelFlow()),
    ).classes('actions'),
  ).classes('notice').attrs({part:'notice'});
  return null;
}
// Text for the shared role=status live region.
export function flowStatus(flow,t){
  if(!flow)return '';
  const host=flow.host;
  if(flow.phase==='waiting'&&flow.presentation==='popup')return host?t('A sign-in window from {host} opened.',{host}):t('A sign-in window opened.');
  if(flow.phase==='redirecting')return flow.fallback?t('Your browser blocked the sign-in window. Continuing in this tab…'):host?t('Continuing at {host}…',{host}):'';
  if(flow.phase==='opening'||flow.phase==='completing')return t('Contacting your identity provider…');
  return '';
}
export function failureText(result,t){
  switch(result?.code){
    case 'invalid-identity':return t(result.message??'Enter a handle like alex@provider.example.');
    case 'discovery-unavailable':return t("We couldn't reach this provider. Check the address and try again.");
    case 'unsupported-provider':return t("This provider isn't supported.");
    case 'no-provider':return result.fallback?t('No Bindle provider was found. Email sign-in requires a configured email service; your app can offer that separately.'):t('No Bindle provider was found at this address.');
    case 'identity-required':return t('Enter your Bindle identity.');
    case 'unregistered-client':return result.host?t("This app isn't connected to {host}.",{host:result.host}):t("This app isn't connected to this provider.");
    case 'not-configured':return t('Bindle sign-in is not configured.');
    default:return t('Sign-in could not be completed. Try again.');
  }
}

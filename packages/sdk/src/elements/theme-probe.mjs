// Theme token resolution for provider islands (components profile §7; A13).
// The token set, contrast pairs, defaults and validator are the islands
// protocol's own (islands-protocol.mjs), so element and island revert the same
// tokens. Elements send only tokens that are in the profile allowlist AND in the
// provider's declared `theme_tokens`. Islands validate again: this is not a
// trust boundary.
import {COLOR_TOKENS,THEME_TOKENS,THEME_DEFAULTS,CONTRAST_PAIRS,contrastRatio,validateThemeTokens} from '../islands-protocol.mjs';

export const colorTokens=COLOR_TOKENS;
export const tokenNames=THEME_TOKENS;
export const providerDefaults=THEME_DEFAULTS;
export const contrastPairs=CONTRAST_PAIRS;
export const contrast=contrastRatio;
export {validateThemeTokens};

// Resolves --bindle-* custom properties on `element` in the embedder's realm.
// Colors go through a hidden probe and a 1×1 canvas round trip, so var(),
// color-mix(), named and wide-gamut colors all normalize to opaque #rrggbb;
// non-opaque results are rejected. `allowed` is the provider's declared
// theme_tokens (capabilities.themeTokens); tokens outside it are never sent.
export function resolveThemeTokens(element,{scheme,allowed=tokenNames}={}){
  const view=element.ownerDocument?.defaultView;if(!view)return {tokens:{},rejected:[]};
  const names=tokenNames.filter(name=>allowed.includes(name)),style=view.getComputedStyle(element),raw={},invalid=[];
  const canvas=element.ownerDocument.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext?.('2d',{willReadFrequently:true});
  const probe=element.ownerDocument.createElement('span');
  probe.style.cssText='position:absolute!important;inline-size:0!important;block-size:0!important;overflow:hidden!important;visibility:hidden!important';
  const host=element.shadowRoot??element;host.append(probe);
  try{
    for(const name of names){
      const value=style.getPropertyValue(`--bindle-${name}`).trim();if(!value)continue;
      if(name==='radius'){if(/^\d{1,2}$/.test(value))raw.radius=Number(value);else invalid.push(name);continue;}
      if(!context)continue;
      probe.style.color='';probe.style.color=`var(--bindle-${name})`;
      const computed=view.getComputedStyle(probe).color;
      context.clearRect(0,0,1,1);context.fillStyle='#000000';context.fillStyle=computed;context.fillRect(0,0,1,1);
      const [r,g,b,a]=context.getImageData(0,0,1,1).data;
      if(a===255)raw[name]='#'+[r,g,b].map(channel=>channel.toString(16).padStart(2,'0')).join('');else invalid.push(name);
    }
  }finally{probe.remove();}
  const result=validateThemeTokens(raw,{scheme:scheme??(view.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light')});
  return {tokens:result.tokens,rejected:[...new Set([...result.rejected,...invalid])]};
}

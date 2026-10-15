// Theme application (profile §7, embed-islands §4.3). Tokens are validated again here (allowlist, grammar,
// contrast matrix against the current scheme's defaults); CSS text is built only from canonical values and
// applied with replaceSync on one adopted constructed sheet (style.setProperty as the fallback). Tokens only
// change colours and the radius: never size, visibility, opacity, position or which controls exist.
// Under forced-colors the stylesheet ignores them; trust-bearing text uses a fixed palette in parts.css.
import {validateThemeTokens} from '../../../packages/sdk/src/islands-protocol.mjs';
export function themeCSS(tokens){return `:root{${Object.entries(tokens).map(([name,value])=>`--t-${name}:${name==='radius'?`${value}px`:value}`).join(';')}}`;}
export function createTheme(doc=globalThis.document){
  let sheet=null,applied=[];
  try{sheet=new doc.defaultView.CSSStyleSheet();doc.adoptedStyleSheets=[...doc.adoptedStyleSheets,sheet];}catch{sheet=null;}
  return Object.freeze({apply(input,scheme){
    const {tokens}=validateThemeTokens(input,{scheme});
    if(sheet){sheet.replaceSync(themeCSS(tokens));return tokens;}
    const style=doc.documentElement.style;for(const name of applied)style.removeProperty(`--t-${name}`);applied=Object.keys(tokens);
    for(const [name,value] of Object.entries(tokens))style.setProperty(`--t-${name}`,name==='radius'?`${value}px`:value);return tokens;
  }});
}

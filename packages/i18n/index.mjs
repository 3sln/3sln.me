import {createTranslator, ObjectCatalogue, ChainCatalogue} from './vendor/bab/index.js';
import {catalogues} from './catalogues.mjs';
export {createTranslator,ObjectCatalogue,ChainCatalogue} from './vendor/bab/index.js';
export const supportedLocales=Object.freeze([{id:'en',name:'English',direction:'ltr'},{id:'es',name:'Español',direction:'ltr'}].map(Object.freeze));
export function resolveLocale(value){try{const language=new Intl.Locale(String(value??'en')).language;return supportedLocales.some(locale=>locale.id===language)?language:'en';}catch{return 'en';}}
// This is a stateless capability factory, not a second reactive model. Locale
// changes live in browserState and create a new formatter capability for render.
export function createLocalization({locale='en',catalogue,onMissing}={}){
 const language=resolveLocale(locale),base=new ObjectCatalogue(catalogues[language]);
 const tr=createTranslator({locale:language,catalogue:catalogue?new ChainCatalogue(catalogue,base):base,onMissing});
 const t=(source,variables)=>String(tr(source,variables));
 t.plural=(source,singular,count,variables={})=>String(tr(source,{...variables,count}).singular(singular));
 t.scope=name=>{const scoped=tr.scope(name);return (source,variables)=>String(scoped(source,variables));};
 const number=(value,options={})=>{try{return new Intl.NumberFormat(language,options).format(value);}catch{return String(value);}};
 const date=(value,options={})=>{if(!Number.isFinite(value))return t('Unknown date');try{return new Intl.DateTimeFormat(language,options).format(value);}catch{return t('Unknown date');}};
 return Object.freeze({locale:language,direction:'ltr',t,number,date});
}

// Compile-time translation contributions follow the same real bab catalogue
// interface. Later modules are explicit overrides; no dictionaries are fetched.
export function catalogueForContributions(contributions=[],locale='en'){
 const language=resolveLocale(locale);
 return new ChainCatalogue(...[...contributions].reverse().map(contribution=>new ObjectCatalogue(contribution.catalogue?.[language]??{})));
}

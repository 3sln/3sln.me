// Strings for provider islands (apps/embed; embed-islands §15, slice I6). Separate from the SDK and portal
// catalogues so the island bundle stays small. bab conventions: the English source text is the key, `{name}`
// parameters, frozen data. Trust-bearing copy (provider host, "the app can't see this list") is fixed provider
// text; embedders never supply island text (profile §5.3: props carry catalogue keys only).
import {createTranslator,ObjectCatalogue} from './vendor/bab/index.js';

const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const islandLocales=freeze([{id:'en',name:'English',direction:'ltr'},{id:'es',name:'Español',direction:'ltr'}]);
const es={
  'Continue with {host}':'Continuar con {host}',
  'Sign in with {host}':'Iniciar sesión con {host}',
  'Sign up with {host}':'Registrarse con {host}',
  'Your accounts at {host}':'Tus cuentas en {host}',
  "This app can't see this list.":'Esta aplicación no puede ver esta lista.',
  'Current account':'Cuenta actual',
  'Show my account at {host}':'Mostrar mi cuenta en {host}',
  'More at {host}':'Más en {host}',
  'Use another account':'Usar otra cuenta',
  'Manage at {host}':'Gestionar en {host}',
  'Remove from this site':'Quitar de este sitio',
  'Remove this account from this site?':'¿Quitar esta cuenta de este sitio?',
  'Remove':'Quitar',
  'Cancel':'Cancelar',
  'Open {host}':'Abrir {host}',
  'Sign-in is not available in this frame.':'El inicio de sesión no está disponible en este marco.',
  'Accounts':'Cuentas',
};
export const islandCatalogues=freeze({en:{'':Object.fromEntries(Object.keys(es).map(key=>[key,key]))},es:{'':es}});
/** Catalogue keys for `props` enums (profile §6). */
export const signInLabels=freeze({continue:'Continue with {host}','sign-in':'Sign in with {host}','sign-up':'Sign up with {host}'});
export function resolveIslandLocale(value){try{const language=new Intl.Locale(String(value??'en')).language;return islandLocales.some(locale=>locale.id===language)?language:'en';}catch{return 'en';}}
export function createIslandLocalization(locale='en'){
  const language=resolveIslandLocale(locale),tr=createTranslator({locale:language,catalogue:new ObjectCatalogue(islandCatalogues[language])});
  return Object.freeze({locale:language,direction:islandLocales.find(item=>item.id===language).direction,t:(source,variables)=>String(tr(source,variables))});
}

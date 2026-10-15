// Strings for the embeddable SDK elements and callback page. Separate from the
// portal catalogue so embedders never bundle it. bab conventions: the English
// source text is the key, `{name}` parameters, `{#}` counts, frozen data.
// Security-relevant copy (provider host announcements, discovery errors, the
// email-fallback disclosure, sign-out scope) is not overridable by embedders.
import {createTranslator,ObjectCatalogue,ChainCatalogue} from './vendor/bab/index.js';

const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const sdkLocales=freeze([{id:'en',name:'English',direction:'ltr'},{id:'es',name:'Español',direction:'ltr'}]);
const es={
  'Your Bindle identity':'Tu identidad Bindle',
  'Use your handle, or enter a full identity from your own provider.':'Usa tu identificador o escribe una identidad completa de tu propio proveedor.',
  '{suffix} will be added unless you type @':'Se añadirá {suffix} salvo que escribas @',
  'Continue':'Continuar',
  'Contacting your identity provider…':'Contactando con tu proveedor de identidad…',
  'Contacting your provider…':'Contactando con tu proveedor…',
  'Sign in':'Iniciar sesión',
  'Sign in with Bindle':'Iniciar sesión con Bindle',
  "You'll continue at {host}.":'Continuarás en {host}.',
  'A sign-in window from {host} opened.':'Se abrió una ventana de inicio de sesión de {host}.',
  'A sign-in window opened.':'Se abrió una ventana de inicio de sesión.',
  'Waiting for {host}…':'Esperando a {host}…',
  'Waiting for your provider…':'Esperando a tu proveedor…',
  'Show window':'Mostrar ventana',
  'Continue in this tab':'Continuar en esta pestaña',
  'Cancel':'Cancelar',
  'Try again':'Reintentar',
  'Your browser blocked the sign-in window.':'Tu navegador bloqueó la ventana de inicio de sesión.',
  'Your browser blocked the sign-in window. Continuing in this tab…':'Tu navegador bloqueó la ventana de inicio de sesión. Continuando en esta pestaña…',
  'Continuing at {host}…':'Continuando en {host}…',
  'Sign-in was canceled.':'Se canceló el inicio de sesión.',
  'Enter a handle like alex@provider.example.':'Escribe un identificador como alex@provider.example.',
  'Use a complete provider hostname.':'Usa un nombre de host completo del proveedor.',
  'Enter your Bindle identity.':'Escribe tu identidad Bindle.',
  "We couldn't reach this provider. Check the address and try again.":'No pudimos contactar con este proveedor. Revisa la dirección e inténtalo de nuevo.',
  "This provider isn't supported.":'Este proveedor no es compatible.',
  'No Bindle provider was found. Email sign-in requires a configured email service; your app can offer that separately.':'No se encontró un proveedor de Bindle. El acceso por correo requiere un servicio de correo configurado; tu aplicación puede ofrecerlo por separado.',
  'Sign-in could not be completed. Try again.':'No se pudo completar el inicio de sesión. Inténtalo de nuevo.',
  'Account: {name}':'Cuenta: {name}',
  'Signed in · {host}':'Sesión iniciada · {host}',
  'Use another account':'Usar otra cuenta',
  "Confirm it's you":'Confirma que eres tú',
  'Sign out of this app':'Cerrar sesión en esta aplicación',
  'Sign out of {host}…':'Cerrar sesión en {host}…',
  'Manage at {host}':'Gestionar en {host}',
  'Other apps and accounts stay signed in unless you choose otherwise at {host}.':'Las demás aplicaciones y cuentas siguen con la sesión iniciada salvo que elijas otra cosa en {host}.',
  'Account':'Cuenta',
  'Account actions':'Acciones de la cuenta',
  'Use a different provider':'Usar otro proveedor',
  'Continue with {host}':'Continuar con {host}',
  'No Bindle provider was found at this address.':'No se encontró un proveedor de Bindle en esta dirección.',
  "This app isn't connected to {host}.":'Esta aplicación no está conectada a {host}.',
  "This app isn't connected to this provider.":'Esta aplicación no está conectada a este proveedor.',
  'Identity picture':'Imagen de identidad',
  'Return to {host}. You can close this window.':'Vuelve a {host}. Puedes cerrar esta ventana.',
  'Return to the app and choose Continue in this tab.':'Vuelve a la aplicación y elige Continuar en esta pestaña.',
  'This sign-in response was not valid. Return to the app and try again.':'Esta respuesta de inicio de sesión no es válida. Vuelve a la aplicación e inténtalo de nuevo.',
  'This sign-in expired or was replaced. Return to the app and try again.':'Este inicio de sesión caducó o fue reemplazado. Vuelve a la aplicación e inténtalo de nuevo.',
  'Bindle sign-in is not configured.':'El inicio de sesión de Bindle no está configurado.',
};
export const sdkCatalogues=freeze({en:{'':Object.fromEntries(Object.keys(es).map(key=>[key,key]))},es:{'':es}});
export function resolveSdkLocale(value){try{const language=new Intl.Locale(String(value??'en')).language;return sdkLocales.some(locale=>locale.id===language)?language:'en';}catch{return 'en';}}
export function createSdkLocalization({locale='en',catalogue,onMissing}={}){
  const language=resolveSdkLocale(locale),base=new ObjectCatalogue(sdkCatalogues[language]);
  const tr=createTranslator({locale:language,catalogue:catalogue?new ChainCatalogue(catalogue,base):base,onMissing});
  const t=(source,variables)=>String(tr(source,variables));
  return Object.freeze({locale:language,direction:sdkLocales.find(item=>item.id===language).direction,t});
}

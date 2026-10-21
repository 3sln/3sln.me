// Provider-owned language and sentence templates. No app-authored effect text.
export const SHIPPED_LOCALES=Object.freeze(['en','es']);
const en={
 tiers:{read:'Can see',private:'Can see private info',write:'Can change',destructive:'Can delete','send-as-you':'Can send as you',money:'Can spend money',identity:'Can change sign-in',public:'Can make public'},
 chips:{'personal-data':'Personal info',location:'Location','send-as-you':'Sends as you',money:'Spends money',identity:'Changes sign-in',public:'Makes public'},
 catalogue:"Description from 3sln.me's catalogue",publisher:host=>`Description from ${host}`,ownPublisher:"Description from the app's own site",unreviewed:'Not checked by 3sln.me',writeWarning:'Not checked: could send, spend or publish as you',english:'(in English)',noDescription:'No description provided',
 fallback:{read:'Can see information',private:'Can see private information',write:'Can change something',destructive:'Can delete something','send-as-you':'Can send as you',money:'Can spend money',identity:'Can change sign-in',public:'Can make something public'},
 settings:'See these shared settings',bus:{read:'See events in this feed',write:'Add events to this feed'},claim:app=>`${app} says why:`,broker:host=>`Your requests go directly to ${host}`,reader:(host,label)=>`Apps that read this feed may act on it: ${host} — ${label}`,
 summary:verbs=>({read:'See information',write:'Change information',destructive:'Delete information','read,write':'See and change information','destructive,read':'See and delete information','destructive,write':'Change and delete information','destructive,read,write':'See, change and delete information'})[verbs],details:n=>`${n} ${n===1?'capability':'capabilities'}: see details`,
};
const es={
 tiers:{read:'Puede ver',private:'Puede ver información privada',write:'Puede cambiar',destructive:'Puede eliminar','send-as-you':'Puede enviar en tu nombre',money:'Puede gastar dinero',identity:'Puede cambiar el inicio de sesión',public:'Puede hacer público'},
 chips:{'personal-data':'Información personal',location:'Ubicación','send-as-you':'Envía en tu nombre',money:'Gasta dinero',identity:'Cambia el inicio de sesión',public:'Hace público'},
 catalogue:'Descripción del catálogo de 3sln.me',publisher:host=>`Descripción de ${host}`,ownPublisher:'Descripción del propio sitio de la app',unreviewed:'Sin revisar por 3sln.me',writeWarning:'Sin revisar: podría enviar, gastar o publicar en tu nombre',english:'(en inglés)',noDescription:'No se proporcionó una descripción',
 fallback:{read:'Puede ver información',private:'Puede ver información privada',write:'Puede cambiar algo',destructive:'Puede eliminar algo','send-as-you':'Puede enviar en tu nombre',money:'Puede gastar dinero',identity:'Puede cambiar el inicio de sesión',public:'Puede hacer algo público'},
 settings:'Ver estos ajustes compartidos',bus:{read:'Ver eventos de esta fuente',write:'Añadir eventos a esta fuente'},claim:app=>`${app} explica por qué:`,broker:host=>`Tus solicitudes van directamente a ${host}`,reader:(host,label)=>`Las apps que leen esta fuente pueden actuar en consecuencia: ${host} — ${label}`,
 summary:verbs=>({read:'Ver información',write:'Cambiar información',destructive:'Eliminar información','read,write':'Ver y cambiar información','destructive,read':'Ver y eliminar información','destructive,write':'Cambiar y eliminar información','destructive,read,write':'Ver, cambiar y eliminar información'})[verbs],details:n=>`${n} ${n===1?'capacidad':'capacidades'}: ver detalles`,
};
export const CONSENT_STRINGS=Object.freeze({en,es});
const list=value=>Array.isArray(value)?value:typeof value==='string'?value.trim().split(/\s+/):[];
const grandfathered=new Set('art-lojban cel-gaulish en-gb-oed i-ami i-bnn i-default i-enochian i-hak i-klingon i-lux i-mingo i-navajo i-pwn i-tao i-tay i-tsu no-bok no-nyn sgn-be-fr sgn-be-nl sgn-ch-de zh-guoyu zh-hakka zh-min zh-min-nan zh-xiang'.split(' '));
const canonical=tag=>{if(typeof tag!=='string')return null;try{return Intl.getCanonicalLocales(tag)[0]?.toLowerCase();}catch{const key=tag.toLowerCase();return /^x(?:-[a-z0-9]{1,8})+$/.test(key)||grandfathered.has(key)?key:null;}};
function lookup(tag,available){let value=canonical(tag);while(value){if(available.has(value))return available.get(value);const end=value.lastIndexOf('-');if(end<0)break;value=value.slice(0,end);if(/-[a-z0-9]$/i.test(value))value=value.slice(0,value.lastIndexOf('-'));}return null;}
export function chooseLocale(options={}){const {account,uiLocales,browser}=options??{},available=new Map(SHIPPED_LOCALES.map(tag=>[tag,tag]));for(const tag of [...list(account),...list(uiLocales),...list(browser)]){const found=typeof tag==='string'&&lookup(tag,available);if(found)return found;}return 'en';}
// Invalid publisher maps are unavailable, rather than partially accepting a
// map that could omit its required English fallback or exceed pinned bounds.
export function publisherText(map,locale,limit=160){
 if(!map||typeof map!=='object'||Array.isArray(map)||!Object.hasOwn(map,'en')||Object.keys(map).length>8)return null;
 const available=new Map();for(const [tag,text] of Object.entries(map)){const key=canonical(tag);if(!key||available.has(key)||typeof text!=='string'||!text.trim()||[...text].length>limit||/[\u0000-\u001f\u007f]/.test(text))return null;available.set(key,tag);}
 const lang=lookup(locale,available)??'en';return {text:map[lang],lang,dir:'auto',isolate:true,languageNote:lang==='en'&&locale!=='en'?CONSENT_STRINGS[locale].english:null};
}

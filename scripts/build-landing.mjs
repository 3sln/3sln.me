import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalization} from '../packages/i18n/index.mjs';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export async function buildLanding({out,css}){
 const texts={freeClosed:'Free account signup is paused while we grow. Paid signup is available.',closed:'Account signup is paused while we grow.',disabled:'This is a private account service. Sign in with your existing account or open your private invitation.',paid:'Choose a paid plan',waitlist:'Join the waitlist'};
 const messages=Object.fromEntries(['en','es'].map(locale=>{const {t}=createLocalization({locale});return [locale,Object.fromEntries(Object.entries(texts).map(([key,value])=>[key,t(value)]))];}));
 const bridge=(await readFile('apps/web/landing.js','utf8')).replace('/*__LANDING_MESSAGES__*/null',JSON.stringify(messages));
 const bridgeURL='/assets/landing.'+createHash('sha256').update(bridge).digest('hex').slice(0,20)+'.js';
 await writeFile(join(out,bridgeURL.slice(1)),bridge);
 const source=await readFile('apps/web/index.html','utf8');
 for(const locale of ['en','es']){
  const {t}=createLocalization({locale});
  let html=source.replace('/landing.js',bridgeURL).replace('href="/styles.css"',`href="${css}"`).replace('<html lang="en">',`<html lang="${locale}">`);
  // Authored text remains a plain, parser-visible document; Bab compiles every
  // consumer message without requiring a runtime translation or app bootstrap.
  html=html.replace(/>([^<>]+)</g,(match,text)=>{const core=text.trim();return core?`>${text.slice(0,text.indexOf(core))}${escape(t(core))}${text.slice(text.indexOf(core)+core.length)}<`:match;});
  html=html.replace('content="One account for compatible apps, flexible storage, and conversations you control."',`content="${escape(t('One account for compatible apps, flexible storage, and conversations you control.'))}"`);
  if(locale==='es'){html=html.replace('value="es"','value="es" selected').replaceAll('/console?signup','/console?signup&amp;lang=es').replaceAll('/console?signin','/console?signin&amp;lang=es').replace('href="/console"','href="/console?lang=es"').replace('3sln.me · Your apps. Your files. Your choice.',escape(`3sln.me · ${t('Your apps.')} ${t('Your files.')} ${t('Your choice.')}`));}
  html=html.replace(/aria-label="([^"]+)"/g,(_,label)=>`aria-label="${escape(t(label))}"`);
  await writeFile(join(out,locale==='es'?'index.es.html':'index.html'),html);
 }
 // Only recognized legacy private fragment entry points are forwarded. Never
 // select a destination from fragment data, and never inspect an account here.
 return ['index.html','index.es.html'];
}

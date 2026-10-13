import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createLocalization} from '../packages/i18n/index.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const forbidden=/^\/(?:api|config|\.well-known|users|contact|c|unsubscribe|recovery|private|logs?)(?:\/|$)/;
function publicPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))throw new TypeError('Invalid public cache asset URL.');
  const url=new URL(value,'https://build.example');
  if(url.origin!=='https://build.example'||url.search||url.hash||url.pathname!==value||forbidden.test(value))throw new TypeError('Unsafe public cache asset URL.');
  for(const part of value.split('/').slice(1)){const decoded=decodeURIComponent(part);if(!decoded||decoded==='.'||decoded==='..'||/[\\/\u0000-\u001f]/.test(decoded))throw new TypeError('Invalid public cache asset path.');}
  return value;
}
async function filesIn(dir){
 const files=[];
 for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),stat=await lstat(path);if(stat.isSymbolicLink())throw new TypeError('Public assets cannot be symbolic links.');if(stat.isDirectory())files.push(...await filesIn(path));else if(stat.isFile())files.push(path);}
 return files;
}
const encodePath=path=>path.split('/').map(encodeURIComponent).join('/');
// Called after js-tools has emitted its final wire-ups, import map, and HTML.
// No source imports are guessed here: every emitted content-addressed artifact
// is included, including vendor shared chunks not named by the import map.
export async function generateServiceWorker(result,{out=result.config.out,publicAssets=[]}={}){
 if(typeof result.buildId!=='string'||!/^[a-f0-9]{10,64}$/.test(result.buildId))throw new TypeError('A final js-tools build ID is required.');
 const root=resolve(out),assetRoot=result.config.assetRoot;
 publicPath('/'+assetRoot);const assetDirectory=join(root,assetRoot),urls=new Set();
 for(const file of await filesIn(assetDirectory)){
  const name=relative(assetDirectory,file).split('\\').join('/');if(name.endsWith('.map'))continue;
  // Stable-name files must be explicitly declared as public, never swept up.
  if(!/[.-][A-Za-z0-9_$]{8,64}\.[^.]+$/.test(name))throw new TypeError(`Unfingerprinted emitted asset: ${name}`);
  if(name.startsWith('offline-index.'))continue;
  urls.add(publicPath('/'+encodePath(relative(root,file).split('\\').join('/'))));
 }
 for(const value of publicAssets){const path=publicPath(value);if(!/\.(?:svg|png|webp|ico|webmanifest|css|html|txt|woff2?)$/.test(path))throw new TypeError('Only explicitly public presentation files may use stable cache URLs.');urls.add(path);}
 const mandatory=[...Object.values(result.imports),...Object.values(result.workers??{}),...Object.values(result.entries).flatMap(entry=>[entry.module,entry.css,entry.wireup].filter(Boolean))];
 for(const value of mandatory){const path=publicPath(value);if(!urls.has(path))throw new TypeError(`Build graph target is not content-addressed: ${path}`);}
 if(!result.html.includes('index.html'))throw new TypeError('An emitted root HTML document is required.');
 const document=await readFile(join(root,'index.html'));
 if(!Object.values(result.entries).some(entry=>document.toString('utf8').includes(entry.wireup)))throw new TypeError('Offline HTML does not reference this build wire-up.');
 const offlineDocument=publicPath('/'+encodePath(`${assetRoot}/offline-index.${digest(document).slice(0,20)}.html`));
 await mkdir(assetDirectory,{recursive:true});await writeFile(join(root,...offlineDocument.split('/').slice(1).map(decodeURIComponent)),document);urls.add(offlineDocument);
 const assets=[];
 for(const url of [...urls].sort()){const file=join(root,...url.split('/').slice(1).map(decodeURIComponent));const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new TypeError('Public asset must be an emitted regular file.');const bytes=await readFile(file);assets.push({url,sha256:digest(bytes)});}
 if(assets.length>2048)throw new TypeError('Public shell cache exceeds the bounded asset manifest.');
 const source=await readFile(new URL('../apps/web/sw.js',import.meta.url),'utf8'),placeholder='/*__3SLN_PUBLIC_BUILD__*/null';
 const setupNotifications=Object.fromEntries(['en','es'].map(locale=>{const {t}=createLocalization({locale});return [locale,{title:t('Confirm account notifications'),body:t('Notifications are working. Return to account setup to continue.')}];}));
 const cacheVersion=digest(JSON.stringify(['3sln-public-shell-v1',result.buildId,assets,digest(source),setupNotifications])).slice(0,20),manifest={buildId:result.buildId,cacheVersion,assets,offlineDocument,setupNotifications};
 if(source.split(placeholder).length!==2)throw new TypeError('Service-worker build placeholder is missing or duplicated.');
 await writeFile(join(root,'sw.js'),source.replace(placeholder,JSON.stringify(manifest)));
 return manifest;
}

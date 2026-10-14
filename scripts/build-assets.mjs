import {cp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,relative,resolve} from 'node:path';
import {build,wireupSource,shortHash} from '@3sln/js-tools';
import {build as checkModules} from 'esbuild';
import config,{publicSources,pages,clientManifest} from '../jstools.config.mjs';

const root=process.cwd(),sourceRoot=resolve(config.src),outputRoot=resolve(config.out);
const posix=path=>path.split('\\').join('/');
const assetURL=path=>'/'+[config.assetRoot,...posix(path).split('/')].map(encodeURIComponent).join('/');

// Preserve relative paths without putting server adapters, credentials, test
// fixtures or the rest of packages/identity into the public module tree.
await rm(sourceRoot,{recursive:true,force:true});
await mkdir(sourceRoot,{recursive:true});
for(const source of publicSources){
  const target=join(sourceRoot,source);
  await mkdir(dirname(target),{recursive:true});
  await cp(source,target,{recursive:true});
}
const result=await build(config);

// 0.2.0 emits .mjs bytes correctly but omits those import-map keys. Complete the
// map from its authoritative module result, and alias authored public URLs to
// the same module identity rather than publishing a second stable copy.
const sourceForURL=new Map(),urlForSource=new Map();
for(const [source,hashed] of result.modules){
  const href=assetURL(hashed),file=resolve(sourceRoot,source);
  result.imports[assetURL(source)]=href;
  const authored=source.startsWith('apps/web/')?'/'+source.slice('apps/web/'.length):'/'+source;
  result.imports[authored]=href;
  sourceForURL.set(href,file);urlForSource.set(file,href);
}
result.imports['/recovery-kdf-worker.mjs']=result.workers.recovery;
result.imports['/message-frame-controller.mjs']=result.workers.messageFrame;
result.imports['/message-sanitizer.mjs']=result.workers.messageSanitizer;
const sdk={login:result.workers.sdkLogin,identity:result.workers.sdkIdentity};
for(const [source,href] of [['packages/sdk/src/login-element.mjs',sdk.login],['packages/sdk/src/identity.mjs',sdk.identity]]){
  // Both first-party imports and the stable public loader converge on the same
  // standalone module, without imposing this application's map on embedders.
  result.imports['/'+source]=href;
  result.imports[assetURL(source)]=href;
  const target=join(outputRoot,source);
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,`export * from ${JSON.stringify(href)};\n`);
  result.copied.push(source);
}
const bundledURLs=new Set([...result.vendor.urlFor.values(),...Object.values(result.workers)]);

// Resolve static and dynamic imports as the browser will: relative to the
// emitted importer URL, then through the complete map. This catches unshipped
// absolute URLs and accidental server imports as well as unmapped packages.
// Checking every shipped module also covers opt-in modules and lazy screens.
await checkModules({
  absWorkingDir:root,
  entryPoints:[...urlForSource.keys()],
  bundle:true,write:false,format:'esm',platform:'browser',
  outdir:join(root,'.output','graph-check'),logLevel:'silent',
  plugins:[{name:'verify-complete-browser-import-map',setup(builder){
    builder.onResolve({filter:/.*/},args=>{
      if(args.kind==='entry-point')return {path:args.path};
      const importerURL=urlForSource.get(resolve(args.importer));
      if(!importerURL)return {errors:[{text:'A module outside the staged public graph was imported.'}]};
      let key=args.path;
      if(key.startsWith('.')||key.startsWith('/')){
        const url=new URL(key,'https://build.example'+importerURL);
        if(url.origin!=='https://build.example')return {errors:[{text:'Cross-origin source imports are not part of the public build.'}]};
        key=url.pathname+url.search+url.hash;
      }
      const mapped=result.imports[key],source=sourceForURL.get(mapped);
      if(source)return {path:source};
      // These exact outputs were already bundled with the browser platform by
      // js-tools, with dependency closure checked by its esbuild invocation.
      if(mapped&&bundledURLs.has(mapped))return {path:mapped,external:true};
      return {errors:[{text:`Unmapped public module ${args.path} imported by ${posix(relative(sourceRoot,args.importer))}`}]};
    });
  }}],
});

// Reuse js-tools' bootstrap generator with the completed map. No app/module
// source is rewritten or bundled. Remove its superseded bootstrap files so the
// service worker cannot cache an incomplete graph alongside the final one.
for(const [name,entry] of Object.entries(result.entries)){
  await rm(join(outputRoot,entry.wireup.slice(1)),{force:true});
  const source=wireupSource({name,imports:result.imports,css:entry.css?[entry.css]:[],module:entry.module});
  entry.wireup=assetURL(`wireup-${name}.${shortHash(Buffer.from(source))}.js`);
  await writeFile(join(outputRoot,entry.wireup.slice(1)),source);
}

const importMap={imports:result.imports};
const importMapCSP='sha256-'+createHash('sha256').update(JSON.stringify(importMap)).digest('base64');

// HTML is the integration boundary. It receives the generated classic wire-up
// before any module starts, plus a parser-visible hashed stylesheet for the
// no-JavaScript public landing content. No inline script is introduced here.
result.html=[];
for(const page of pages){
  const entry=result.entries[page.entry];
  let html=await readFile(page.source,'utf8');
  const oldScript=`<script type="module" src="${page.module}"></script>`;
  if(!html.includes(oldScript))throw Error(`Expected application entry script missing from ${page.source}`);
  html=html.replace(oldScript,`<script src="${entry.wireup}"></script>`);
  if(entry.css)html=html.replace('href="/styles.css"',`href="${entry.css}"`);
  html=html.replace('</head>',`<meta name="bindle-import-map-csp" content="${importMapCSP}"></head>`);
  if(/<script\b[^>]*type=["']module["']/i.test(html))throw Error(`Unmanaged module script in ${page.source}`);
  await writeFile(join(outputRoot,page.output),html);
  result.html.push(page.output);
}

const {buildLanding}=await import('./build-landing.mjs');
result.html.push(...await buildLanding({out:outputRoot,css:result.entries.app.css}));

async function files(directory){
  const out=[];
  for(const item of await readdir(directory,{withFileTypes:true})){
    const full=join(directory,item.name);
    if(item.isDirectory())out.push(...await files(full));else out.push(full);
  }
  return out;
}
const immutableFiles=(await files(join(outputRoot,config.assetRoot))).sort();
const immutableURLs=immutableFiles.map(file=>'/'+posix(relative(outputRoot,file)));
// Include workers and copied public shell bytes too: an icon, manifest or HTML
// change must select a fresh service-worker cache even if no module changed.
const buildHash=createHash('sha256');
for(const file of [...new Set([...immutableFiles,...result.copied.map(path=>join(outputRoot,path)),...result.html.map(path=>join(outputRoot,path))])].sort()){
  buildHash.update(posix(relative(outputRoot,file)));buildHash.update('\0');buildHash.update(await readFile(file));buildHash.update('\0');
}
result.buildId=buildHash.digest('hex').slice(0,20);
const manifest={buildId:result.buildId,entries:result.entries,imports:result.imports,workers:result.workers,sdk,assets:immutableURLs,importMapCSP};
await mkdir(dirname(resolve(clientManifest)),{recursive:true});
await writeFile(clientManifest,`// Generated by scripts/build-assets.mjs using @3sln/js-tools.\nexport const BUILD_ID=${JSON.stringify(result.buildId)};\nexport const IMPORT_MAP=${JSON.stringify(importMap)};\nexport const ENTRIES=${JSON.stringify(result.entries)};\nexport const WORKERS=${JSON.stringify(result.workers)};\nexport const IMPORT_MAP_CSP=${JSON.stringify(importMapCSP)};\nexport default ${JSON.stringify(manifest)};\n`);
await writeFile(join(outputRoot,'build-manifest.json'),JSON.stringify(manifest));

await import('./build-docs.mjs');
const {generateServiceWorker}=await import('./build-service-worker.mjs');
// The manifest is branded by the HTTP adapter, so its served bytes are dynamic
// and cannot be pinned to the copied source file's integrity digest.
await generateServiceWorker(result,{out:outputRoot,publicAssets:['/icon.svg','/generic-icon.svg','/branding/3sln-avatar.png','/branding/3sln-lockup.svg','/branding/3sln-lockup-ondark.svg','/demo.css']});
console.log(`Public build ${result.buildId}: ${result.modules.size} individually addressed modules, 3 isolated worker modules, 2 standalone SDK entries, complete import-map graph verified.`);

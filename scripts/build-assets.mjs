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
// Islands modules (apps/embed) belong to the embed origin's graph below, never to the app's map or /assets tree.
const embedOnly=source=>posix(source).startsWith('apps/embed/');
for(const [source,hashed] of result.modules){
  if(embedOnly(source))continue;
  const href=assetURL(hashed),file=resolve(sourceRoot,source);
  result.imports[assetURL(source)]=href;
  const authored=source.startsWith('apps/web/')?'/'+source.slice('apps/web/'.length):'/'+source;
  result.imports[authored]=href;
  sourceForURL.set(href,file);urlForSource.set(file,href);
}
result.imports['/recovery-kdf-worker.mjs']=result.workers.recovery;
result.imports['/message-frame-controller.mjs']=result.workers.messageFrame;
result.imports['/message-sanitizer.mjs']=result.workers.messageSanitizer;
const sdk={define:result.workers.sdkDefine,callback:result.workers.sdkCallback,identity:result.workers.sdkIdentity};
for(const [source,href] of [['packages/sdk/src/define.mjs',sdk.define],['packages/sdk/src/callback.mjs',sdk.callback],['packages/sdk/src/identity.mjs',sdk.identity]]){
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
// Returns the staged source files the graph actually reaches.
async function verifyBrowserGraph({entryPoints,urlOf,sourceOf,imports,bundled=new Set(),label}){
  const checked=await checkModules({
    absWorkingDir:root,
    entryPoints,
    bundle:true,write:false,format:'esm',platform:'browser',metafile:true,
    outdir:join(root,'.output','graph-check'),logLevel:'silent',
    plugins:[{name:'verify-complete-browser-import-map',setup(builder){
      builder.onResolve({filter:/.*/},args=>{
        if(args.kind==='entry-point')return {path:args.path};
        const importerURL=urlOf.get(resolve(args.importer));
        if(!importerURL)return {errors:[{text:`A module outside the staged ${label} graph was imported.`}]};
        let key=args.path;
        if(key.startsWith('.')||key.startsWith('/')){
          const url=new URL(key,'https://build.example'+importerURL);
          if(url.origin!=='https://build.example')return {errors:[{text:'Cross-origin source imports are not part of the public build.'}]};
          key=url.pathname+url.search+url.hash;
        }
        const mapped=imports[key],source=sourceOf.get(mapped);
        if(source)return {path:source};
        // These exact outputs were already bundled with the browser platform by
        // js-tools, with dependency closure checked by its esbuild invocation.
        if(mapped&&bundled.has(mapped))return {path:mapped,external:true};
        return {errors:[{text:`Unmapped public module ${args.path} imported by ${posix(relative(sourceRoot,args.importer))} (${label})`}]};
      });
    }}],
  });
  return Object.keys(checked.metafile.inputs).map(input=>resolve(root,input)).filter(file=>file.startsWith(sourceRoot+'/'));
}
await verifyBrowserGraph({entryPoints:[...urlForSource.keys()],urlOf:urlForSource,sourceOf:sourceForURL,imports:result.imports,bundled:bundledURLs,label:'app'});

// ---- Islands shell for the dedicated embed origin (embed islands §3; components profile §3) ----
// The shell is a cross-origin document with `script-src 'self'` and Trusted Types, so it cannot run the app's wire-up.
// Its module graph is re-rooted under /embed/assets/ with its own static import map (hashed into the shell CSP), checked
// exactly as the browser resolves it. The worker is the standalone js-tools bundle. Nothing of it stays under /assets/,
// so the app origin and its service worker never carry island code (federation mount review M3).
const EMBED_ROOT='embed/assets',embedURL=path=>'/'+[...EMBED_ROOT.split('/'),...posix(path).split('/')].map(encodeURIComponent).join('/');
const embedEntry=result.entries.embed,embedWorker=result.workers.embedWorker;
if(!embedEntry?.css||!embedWorker)throw Error('The islands entry and worker were not built.');
const embedImportsAll={},embedSourceOf=new Map(),embedURLOf=new Map();
for(const [source,hashed] of result.modules){const href=embedURL(hashed),file=resolve(sourceRoot,source);embedImportsAll[embedURL(source)]=href;embedSourceOf.set(href,file);embedURLOf.set(file,href);}
const embedGraph=(await verifyBrowserGraph({entryPoints:[resolve(sourceRoot,'apps/embed/src/boot.mjs')],urlOf:embedURLOf,sourceOf:embedSourceOf,imports:embedImportsAll,label:'embed'})).map(file=>posix(relative(sourceRoot,file))).sort();
const embedImports={},embedOutputs=[];
const toEmbed=async(fromAsset,rel)=>{const target=join(outputRoot,EMBED_ROOT,rel);await mkdir(dirname(target),{recursive:true});await cp(join(outputRoot,fromAsset),target);embedOutputs.push(target);return embedURL(rel);};
for(const source of embedGraph){const hashed=result.modules.get(source);if(!hashed)throw Error(`Islands module ${source} was not fingerprinted.`);embedImports[embedURL(source)]=await toEmbed(join(config.assetRoot,hashed),hashed);}
const assetRel=url=>decodeURIComponent(url.slice(`/${config.assetRoot}/`.length));
const embedBoot=embedImports[embedURL('apps/embed/src/boot.mjs')],embedShellCSS=await toEmbed(embedEntry.css.slice(1),assetRel(embedEntry.css)),embedWorkerURL=await toEmbed(embedWorker.slice(1),assetRel(embedWorker));
const partsCSS=Buffer.from((await checkModules({absWorkingDir:root,entryPoints:['apps/embed/styles/parts.css'],bundle:true,minify:config.minifyCss!==false,write:false,logLevel:'warning'})).outputFiles[0].contents);
const partsRel=`embed-parts.${shortHash(partsCSS)}.css`;await mkdir(join(outputRoot,EMBED_ROOT),{recursive:true});await writeFile(join(outputRoot,EMBED_ROOT,partsRel),partsCSS);embedOutputs.push(join(outputRoot,EMBED_ROOT,partsRel));
// Remove island-only outputs from the app tree and map; shared modules (vendored dodo/ngin, the islands protocol and
// catalogue) stay where the app may use them.
for(const [source,hashed] of result.modules)if(embedOnly(source))await rm(join(outputRoot,config.assetRoot,hashed),{force:true});
await rm(join(outputRoot,config.assetRoot,'apps','embed'),{recursive:true,force:true});
for(const url of [embedEntry.css,embedEntry.wireup,embedWorker])await rm(join(outputRoot,url.slice(1)),{force:true});
for(const [key,value] of Object.entries(result.imports))if(value===embedWorker||embedOnly(key.replace(/^\/(?:assets\/)?/,'')))delete result.imports[key];
delete result.entries.embed;delete result.workers.embedWorker;
// The shell template: hashed stylesheets, the static import map ahead of the hashed boot module, and the per-client
// config slot that packages/federation/embed-shell.mjs fills at request time.
const embedImportMap=JSON.stringify({imports:embedImports}).replaceAll('<','\\u003c');
const embedScriptHash='sha256-'+createHash('sha256').update(embedImportMap).digest('base64');
let shell=await readFile('apps/embed/shell.html','utf8');
for(const [authored,hashed] of [['/embed/assets/apps/embed/styles/shell.css',embedShellCSS],['/embed/assets/apps/embed/styles/parts.css',embedURL(partsRel)]]){const tag=`<link rel="stylesheet" href="${authored}">`;if(!shell.includes(tag))throw Error(`Expected ${tag} in apps/embed/shell.html`);shell=shell.replace(tag,()=>`<link rel="stylesheet" href="${hashed}">`);}
const bootTag='<script type="module" src="/embed/assets/apps/embed/src/boot.mjs"></script>';if(!shell.includes(bootTag))throw Error('Expected the islands boot script in apps/embed/shell.html');
shell=shell.replace(bootTag,()=>`<script type="importmap">${embedImportMap}</script>\n<script type="module" src="${embedBoot}"></script>`);
const {shellBuild,shellConfig,fillShell}=await import('../packages/federation/embed-shell.mjs');
const embedBuild={v:1,worker:embedWorkerURL,sw:'/embed/sw.js',scripts:[embedScriptHash]};
if(!shellBuild(embedBuild))throw Error('Invalid islands shell build description.');
const probe=fillShell(shell,shellConfig({issuer:'https://provider.example',clientId:'https://app.example/</script>',origins:['https://app.example'],build:shellBuild(embedBuild)}));
if(/<\/script>"/.test(probe)||JSON.parse(/<script type="application\/json" id="config">(.*?)<\/script>/s.exec(probe)?.[1]??'null')?.clientId!=='https://app.example/</script>')throw Error('The islands shell config slot does not round-trip safely.');
await writeFile(join(outputRoot,'embed','shell.html'),shell);await writeFile(join(outputRoot,'embed','shell.json'),JSON.stringify(embedBuild));
// The service worker's cache generation is derived from every byte it may serve (IMPL-6), so a new build retires it.
const embedHash=createHash('sha256');for(const file of [...embedOutputs].sort()){embedHash.update(posix(relative(outputRoot,file)));embedHash.update('\0');embedHash.update(await readFile(file));embedHash.update('\0');}embedHash.update(shell);
const embedBuildId=embedHash.digest('hex').slice(0,20);
const swSource=await readFile('apps/embed/sw.js','utf8'),generation="const GENERATION='bindle-embed-1'";if(swSource.split(generation).length!==2)throw Error('Expected one GENERATION constant in apps/embed/sw.js');
await writeFile(join(outputRoot,'embed','sw.js'),swSource.replace(generation,()=>`const GENERATION='bindle-embed-${embedBuildId}'`));
const {gzipSync}=await import('node:zlib');const shellBytes=gzipSync(probe).length;

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
// Host administration modules load only on /console?boot|admin; keep them out
// of the shell cache every visitor's service worker installs.
const privateAssets=[...result.modules].filter(([source])=>/^apps\/web\/src\/(?:admin-[a-z-]+\.mjs|(?:bl|ui|providers)\/admin-[a-z-]+\.mjs)$/.test(posix(source))).map(([,hashed])=>assetURL(hashed));
if(privateAssets.length<7)throw Error('Host administration modules were not found in the public build.');
await generateServiceWorker(result,{out:outputRoot,privateAssets,publicAssets:['/icon.svg','/generic-icon.svg','/branding/3sln-avatar.png','/branding/3sln-lockup.svg','/branding/3sln-lockup-ondark.svg','/demo.css']});
console.log(`Public build ${result.buildId}: ${result.modules.size} individually addressed modules, 3 isolated worker modules, 2 standalone SDK entries, complete import-map graph verified.`);
console.log(`Islands build ${embedBuildId}: ${embedGraph.length} modules under /${EMBED_ROOT}/, standalone island worker, import-map graph verified; shell ${shellBytes} bytes gzip (design budget 2048).`);

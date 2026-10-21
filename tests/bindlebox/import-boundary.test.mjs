// Parse static imports/re-exports/literal dynamic imports with esbuild, including minified syntax.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../',import.meta.url));
const box=path=>/^packages\/bindlebox-[^/]+\//.test(path)||path.startsWith('apps/bindlebox/')||path==='scripts/bindlebox.mjs';
const shared=path=>path==='packages/core/primitives.mjs'||/^(packages\/(content|sdk)\/|vendor\/(ngin|dodo)\/)/.test(path);
const normalize=path=>relative(root,path).replaceAll('\\','/');
function violation(importer,specifier){
 // Bare npm and node imports are external. Internal import-map aliases need explicit review.
 if(!specifier.startsWith('.')&&!isAbsolute(specifier)&&!specifier.startsWith('file:'))return specifier.startsWith('#')&&box(importer)?`${importer}: unreviewed alias ${specifier}`:null;
 const target=normalize(specifier.startsWith('file:')?fileURLToPath(specifier):resolve(root,dirname(importer),specifier));
 if(box(importer))return box(target)||shared(target)?null:`${importer} imports forbidden ${target}`;
 return box(target)?`${importer} imports BindleBox ${target}`:null;
}
async function files(directory){const result=[];for(const entry of await readdir(resolve(root,directory),{withFileTypes:true})){if(['node_modules','.output','dist','public'].includes(entry.name))continue;const path=`${directory}/${entry.name}`;if(entry.isDirectory())result.push(...await files(path));else if(/\.(mjs|js|cjs)$/.test(path))result.push(resolve(root,path));}return result;}
async function scan(options){
 const errors=[];await build({...options,absWorkingDir:root,bundle:true,treeShaking:false,write:false,outdir:'.output/bindlebox-boundary',platform:'neutral',logLevel:'silent',plugins:[{name:'bindlebox-boundary',setup(builder){builder.onResolve({filter:/.*/},args=>{if(args.kind==='entry-point')return;const error=violation(isAbsolute(args.importer)?normalize(args.importer):args.importer,args.path);if(error)errors.push(error);return {path:args.path,external:true};});}}]});return errors.sort();
}
test('core and BindleBox import only across the extraction plan’s allowed shared boundary',async()=>{
 const sources=(await Promise.all(['packages','apps','scripts','vendor/ngin','vendor/dodo'].map(files))).flat();
 assert.deepEqual(await scan({entryPoints:sources}),[]);
});
test('boundary parser catches re-exports and literal dynamic imports and permits the shared exceptions',async()=>{
 for(const source of ['import"../runtime/accounts.mjs";','export{AccountController}from"../runtime/accounts.mjs";','const load=()=>import("../runtime/accounts.mjs");'])assert.equal((await scan({stdin:{contents:source,sourcefile:'probe.mjs',resolveDir:resolve(root,'packages/bindlebox-engine')}})).length,1);
 assert.equal(violation('packages/core/probe.mjs','../bindlebox-engine/engine.mjs')?.includes('imports BindleBox'),true);
 for(const path of ['../core/primitives.mjs','../content/render.mjs','../sdk/src/index.mjs','../../vendor/ngin/index.js','../../vendor/dodo/index.js','some-npm-package','node:crypto'])assert.equal(violation('packages/bindlebox-engine/probe.mjs',path),null,path);
 for(const path of ['../links/envelope.mjs','../core/engine.mjs','../app/engine.mjs','../messaging/store.mjs'])assert.ok(violation('packages/bindlebox-engine/probe.mjs',path),path);
});

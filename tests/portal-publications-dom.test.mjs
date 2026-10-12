import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';

test('publications factory uses real DOM, untranslated user content and native CRUD intent through ngin',async()=>{
 const window=new Window({url:'https://portal.example/'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','ErrorEvent','Node','Element','FormData'],previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
 for(const name of names)globalThis[name]=window[name];
 const dodo=await import('../vendor/dodo/index.js');
 const {Engine,Provider}=await import('../vendor/ngin/index.js');
 const {compilePortalModules,composePortalViews,RunPortalCommand}=await import('../packages/portal/index.mjs');
 const {publicationsModule,PublicationsProvider,MemoryPublicationStorage,Publications}=await import('../modules/publications/index.mjs');
 const {createLocalization}=await import('../packages/i18n/index.mjs');
 class Access extends Provider {static deps=[];obtain(){return Promise.resolve({owner:'alice'});}release(){}}
 const engine=new Engine({providers:{portalAccess:Access,publicationStorage:MemoryPublicationStorage,publications:PublicationsProvider}}),registry=compilePortalModules([publicationsModule]),views=composePortalViews(registry,{h:dodo.h,t:createLocalization({locale:'es'}).t});
 document.body.innerHTML='<main id="root"></main>';const root=document.getElementById('root');let finished;
 const render=async()=>dodo.reconcile(root,[views.publications({publications:await engine.query(new Publications()).peek()})]);
 root.addEventListener('3sln-intent',event=>{event.stopPropagation();const {command,detail}=event.detail;finished=engine.dispatch(new RunPortalCommand(registry,command,detail)).next('complete').then(render);});
 try{
  await render();assert.match(root.textContent,/Publicaciones/);assert.match(root.textContent,/Crear publicación/);
  let form=root.querySelector('form');form.querySelector('[name=title]').value='User English title';form.querySelector('[name=body]').value='<script>user text</script>';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await finished;
  assert.match(root.textContent,/User English title/);assert.match(root.textContent,/<script>user text<\/script>/);assert.equal(root.querySelector('script'),null);
  form=root.querySelector('article form');form.querySelector('[name=title]').value='Changed';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await finished;
  assert.match(root.textContent,/Changed/);assert.equal((await engine.query(new Publications()).peek())[0].revision,2);
  [...root.querySelectorAll('article button')].find(button=>button.textContent==='Eliminar publicación').click();await finished;assert.deepEqual(await engine.query(new Publications()).peek(),[]);
 }finally{dodo.reconcile(root,[]);await engine.dispose();await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];}
});

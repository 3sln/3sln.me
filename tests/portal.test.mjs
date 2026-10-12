import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,Provider} from '../vendor/ngin/index.js';
import {compilePortalModules,portalContributionsProvider,PortalContributions,RunPortalCommand,composePortalViews} from '../packages/portal/index.mjs';
import {publicationsModule,PublicationsProvider,MemoryPublicationStorage,CreatePublication,UpdatePublication,DeletePublication,Publications} from '../modules/publications/index.mjs';
const module=(id,dependencies=[],contributions={})=>({id,dependencies,contributions});
test('compile-time modules validate dependencies and deterministically order contributions',()=>{
 const modules=[module('z',['a'],{navigation:[{id:'last',order:20}]}),module('a',[],{navigation:[{id:'first',order:1}]})];
 const left=compilePortalModules(modules),right=compilePortalModules([...modules].reverse());
 assert.deepEqual(left.snapshot(),right.snapshot());assert.deepEqual(left.list('navigation').map(item=>item.id),['first','last']);assert.equal(left.get('navigation','first').module,'a');assert.ok(Object.isFrozen(left.snapshot().navigation));
 assert.throws(()=>compilePortalModules([module('a'),module('a')]),/Duplicate portal module/);
 assert.throws(()=>compilePortalModules([module('a',['missing'])]),/Missing portal module/);
 assert.throws(()=>compilePortalModules([module('a',['b']),module('b',['a'])]),/cycle/);
 assert.throws(()=>compilePortalModules([module('a',[],{navigation:[{id:'x'},{id:'x'}]})]),/Duplicate navigation/);
 assert.throws(()=>compilePortalModules([module('a',[],{unknown:[]})]),/Unknown/);
});
test('contributions use real Provider and Query and pure factory composition',async()=>{
 const registry=compilePortalModules([{id:'sample',contributions:{views:[{id:'sample',factory:({t})=>state=>t('Hello {name}',{name:state.name})}]}}]);
 const views=composePortalViews(registry,{t:(source,params)=>source.replace('{name}',params.name)});
 assert.equal(views.sample({name:'Ray'}),'Hello Ray');assert.throws(()=>composePortalViews(registry,{t:()=>'',engine:{}}),/cannot expose/);
 const engine=new Engine({providers:{portalContributions:portalContributionsProvider([module('a')])}});
 assert.deepEqual((await engine.query(new PortalContributions()).peek()).modules,[{id:'a',dependencies:[]}]);await engine.dispose();
});
test('registered command cannot execute before authorization leases succeed',async()=>{
 let executed=0;
 const registry=compilePortalModules([module('sample',[],{commands:[{id:'danger',capability:'delete',deps:{},execute:()=>executed++}]})]);
 class Denied extends Provider {static deps=[];obtain(){throw new Error('Denied by authority');}}
 const engine=new Engine({providers:{portalAccess:Denied}}),feed=engine.dispatch(new RunPortalCommand(registry,'danger'));
 await assert.rejects(feed.next('complete'),/Denied by authority/);assert.equal(executed,0);await engine.dispose();
});
test('publications sample provides real owner-scoped CRUD with narrowed handles and revision checks',async()=>{
 const grants=[];class Access extends Provider {static deps=[];obtain(options){grants.push(options.capability);return Promise.resolve({owner:'alice'});}release(){}}
 const engine=new Engine({providers:{portalAccess:Access,publicationStorage:MemoryPublicationStorage,publications:PublicationsProvider}});
 const run=async action=>{const feed=engine.dispatch(action);await feed.next('complete');};
 await run(new CreatePublication({title:'One',body:'User content in English is unchanged.'}));
 let [entry]=await engine.query(new Publications()).peek();assert.equal(entry.title,'One');
 await run(new UpdatePublication({id:entry.id,revision:entry.revision,title:'Two',body:'Updated'}));
 [entry]=await engine.query(new Publications()).peek();assert.equal(entry.revision,2);assert.equal(entry.title,'Two');
 await assert.rejects(engine.dispatch(new DeletePublication({id:entry.id,revision:1})).next('complete'),/changed/);
 const provider=engine.container.get('publications'),handle=await provider.obtain({operation:'list'});assert.deepEqual(Object.keys(handle),['list']);await provider.release(handle);
 await run(new DeletePublication({id:entry.id,revision:entry.revision}));assert.deepEqual(await engine.query(new Publications()).peek(),[]);
 assert.ok(grants.includes('publications.create'));assert.ok(grants.includes('publications.remove'));await engine.dispose();
 const sample=compilePortalModules([publicationsModule]);assert.equal(sample.list('routes').length,4);assert.equal(sample.list('contracts')[0].sample,true);
});
test('publication storage denies cross-owner mutations and requires explicit owner grants',async()=>{
 const storage=new MemoryPublicationStorage(),resource=await storage.obtain(),entry=resource.create('alice',{title:'Private',body:'Body'});
 assert.deepEqual(resource.list('bob'),[]);assert.throws(()=>resource.update('bob',entry.id,{title:'X',body:'Y',revision:1}),/not found/);
 class Ownerless extends Provider {obtain(){return Promise.resolve({});}release(){}}
 const provider=new PublicationsProvider({portalAccess:new Ownerless(),publicationStorage:storage});await assert.rejects(provider.obtain({operation:'create'}),/owner-scoped/);
});

test('command array dependencies normalize to real ngin declarations',async()=>{
 let captured;const registry=compilePortalModules([module('sample',[],{commands:[{id:'inspect',capability:'read',deps:['value'],execute:resources=>{captured=resources.value;}}]})]);
 const engine=new Engine({providers:{value:Provider.fromSingleton('allowed'),portalAccess:Provider.fromSingleton({owner:'alice'})}});
 await engine.dispatch(new RunPortalCommand(registry,'inspect')).next('complete');assert.equal(captured,'allowed');await engine.dispose();
});

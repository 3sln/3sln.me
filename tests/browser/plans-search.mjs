import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/'}),names=['document','HTMLElement','CustomEvent','Event','EventTarget','ErrorEvent','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
for(const name of names)globalThis[name]=window[name];
const {Engine,Provider,dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {NavigateSpace,LoadBilling,BillingCheckout,BillingPortal,SearchSpace,NetworkChanged,ReadSearchMessage}=await import('../../apps/web/src/bl/release.mjs');
const {default:billingView,formatStorage,formatAnnualPrice}=await import('../../apps/web/src/ui/release-billing.mjs');
const {default:searchView}=await import('../../apps/web/src/ui/release-search.mjs');
const {default:inboxView}=await import('../../apps/web/src/ui/release-inbox.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
const {compilePortalModules}=await import('../../packages/portal/index.mjs');
const {builtInModules}=await import('../../apps/web/src/shared/portal-modules.mjs');
test.after(async()=>{await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});
const storage={plan:'free',planName:'Free',storageBytes:500000000,usedBytes:123450000,remainingBytes:376550000,reservedBytes:2000000,messagesBytes:100000000,objectsBytes:23450000,messageCount:101,objectCount:4};
const plans=[{id:'free',name:'Free',storageBytes:500000000,annualAmount:0,currency:'usd'},{id:'plus',name:'Plus',storageBytes:5000000000,annualAmount:500,currency:'usd'},{id:'pro',name:'Pro',storageBytes:100000000000,annualAmount:3000,currency:'usd'}];
async function fixture(){
 let serial=0;const calls=[],navigations=[],account={id:'owner',handle:'river'};
 const api={csrf:'token',async get(path){calls.push({path});if(path==='/api/account')return {account,storage,messages:[],collections:[],contacts:[]};if(path==='/api/billing')return {plan:'free',enabled:false,configured:false,plans};if(path==='/api/session')return {account};throw new Error(path);},async request(path,body,method){calls.push({path,body,method});return {url:'https://polar.sh/checkout/example'};}};
 const browser={id:()=>`request-${++serial}`,navigate:url=>navigations.push(url),captureFocus(){},modalFocus(){},restoreFocus(){},consumeSubmission:()=>({q:'private phrase',tag:'owner-tag',type:'message'})};
 const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),portalContributions:Provider.fromSingleton(compilePortalModules(builtInModules)),recoveryFile:Provider.fromSingleton({})}});
 await engine.container.use({state:{write:true}},({state})=>state.transition(next=>Object.assign(next,{loading:false,session:{account},data:{account,storage,messages:[],collections:[],contacts:[]}})));
 return {engine,api,calls,navigations,act:action=>engine.dispatch(action).next('complete'),read:()=>engine.container.use(['state'],({state})=>state.snapshot()),write:patch=>engine.container.use({state:{write:true}},({state})=>state.transition(next=>Object.assign(next,patch)))};
}
const render=(view,state)=>{const root=document.createElement('main');dodo.reconcile(root,[localize(view(state),createLocalization({locale:state.locale??'en'}))]);return root;};
test('storage shows decimal limits, localized prices, preserved bytes and unavailable checkout',()=>{
 const state={locale:'es',data:{storage:{...storage,overLimit:true}},billing:{plan:'free',enabled:false,configured:false,plans},config:{}};
 const root=render(billingView,state);assert.match(root.textContent,/Almacenamiento y facturación/);assert.match(root.textContent,/500 MB/);assert.match(root.textContent,/5 GB/);assert.match(root.textContent,/100 GB/);assert.match(root.textContent,/planes de pago aún no están disponibles/);assert.match(root.textContent,/seguir leyendo, exportando y eliminando/);assert.equal(root.querySelectorAll('meter').length,1);
 const planButtons=[...root.querySelectorAll('.plan-card button')];assert.ok(planButtons.every(button=>button.disabled));assert.equal(formatStorage(500000000,'en'),'500 MB');assert.equal(formatStorage(123450000,'es'),'123,45 MB');assert.equal(formatAnnualPrice(500,'USD','en'),'$5');
 assert.equal(compilePortalModules(builtInModules).get('keybindings','space-search.binding-0').key,'mod+shift+f');
});
test('billing Actions block missing configuration, reject untrusted navigation and never optimistically grant storage',async()=>{
 const f=await fixture();try{
  await f.act(new NavigateSpace({kind:'navigate',view:'billing'}));await f.act(new BillingCheckout({plan:'plus'}));assert.equal(f.calls.filter(call=>call.path==='/api/billing/checkout').length,0);
  await f.write({billing:{plan:'free',enabled:true,configured:false,server:'production'}});await f.act(new BillingCheckout({plan:'pro'}));assert.equal(f.calls.filter(call=>call.path==='/api/billing/checkout').length,0);
  await f.write({billing:{plan:'free',enabled:true,configured:true,server:'production'}});f.api.request=async(path,body)=>{f.calls.push({path,body});return {url:'https://evil.example/checkout'};};await f.act(new BillingCheckout({plan:'plus'}));assert.deepEqual(f.navigations,[]);
  f.api.request=async()=>({url:'https://polar.sh/checkout/example'});await f.act(new BillingCheckout({plan:'plus'}));assert.deepEqual(f.navigations,['https://polar.sh/checkout/example']);assert.equal((await f.read()).data.storage.plan,'free');
  f.api.get=async path=>{if(path==='/api/account')return {storage,account:{id:'owner'},messages:[]};throw new Error('provider unavailable');};await f.act(new LoadBilling());const root=render(billingView,await f.read());assert.match(root.textContent,/Plan information could not be loaded/);assert.ok([...root.querySelectorAll('.plan-card button')].every(button=>button.disabled));
 }finally{await f.engine.dispose();}
});
test('search consumes captured form values, cursor pages preserve user language, index lag and failure states',async()=>{
 const f=await fixture();try{
  let page=0;f.api.get=async path=>{f.calls.push({path});return {items:[{id:`message:${++page}`,source:{kind:'message',id:String(page)},type:'message',title:'Inbox',snippet:'Free <script>owner text</script>',tags:['Storage']}],cursor:page===1?'next-page':null,indexing:{pending:1,ready:false},bounded:true};};
  await f.act(new SearchSpace({operationId:'submission'}));assert.match(f.calls[0].path,/q=private\+phrase/);assert.match(f.calls[0].path,/tag=owner-tag/);assert.match(f.calls[0].path,/mode=lexical/);
  await f.act(new SearchSpace({kind:'search-next-page'}));assert.match(f.calls[1].path,/cursor=next-page/);assert.equal((await f.read()).spaceSearch.items.length,2);
  const root=render(searchView,{...await f.read(),locale:'es'});assert.match(root.textContent,/Buscar en tu espacio/);assert.match(root.textContent,/se está actualizando/);assert.equal(root.querySelector('h3').textContent,'Inbox');assert.match(root.textContent,/Free <script>owner text<\/script>/);assert.equal(root.querySelector('script'),null);
  f.api.get=async()=>{throw new Error('offline database details');};await f.act(new SearchSpace({values:{q:'missing'}}));assert.equal((await f.read()).spaceSearch.phase,'error');assert.match(render(searchView,await f.read()).textContent,/Search could not be completed/);assert.equal(JSON.stringify(await f.read()).includes('offline database details'),false);
 }finally{await f.engine.dispose();}
});
test('late and superseded search replies cannot restore stale results, and results outside loaded inbox are readable',async()=>{
 const f=await fixture();try{
  const replies=[];f.api.get=path=>new Promise(resolve=>replies.push(resolve));
  const first=f.act(new SearchSpace({values:{q:'first'}}));await new Promise(resolve=>setTimeout(resolve,10));
  const second=f.act(new SearchSpace({values:{q:'second'}}));await new Promise(resolve=>setTimeout(resolve,10));
  replies[1]({items:[{id:'latest',title:'latest'}]});await second;replies[0]({items:[{id:'stale',title:'stale'}]});await first;assert.equal((await f.read()).spaceSearch.items[0].id,'latest');
  const offline=f.act(new SearchSpace({values:{q:'offline'}}));await new Promise(resolve=>setTimeout(resolve,10));await f.act(new NetworkChanged({online:false}));replies[2]({items:[{id:'private late result'}]});await offline;assert.deepEqual((await f.read()).spaceSearch.items,[]);
  await f.write({offline:false,session:{account:{id:'owner'}},data:{messages:[],contacts:[],collections:[]}});f.api.get=async path=>path==='/api/account'?{messages:[],contacts:[],collections:[]}:{message:{id:'older-message',title:'Beyond the loaded page',text:'Owner body',receivedAt:1,readAt:1},render:{kind:'text'}};
  await f.act(new ReadSearchMessage({id:'older-message'}));assert.equal((await f.read()).view,'inbox');assert.match(render(inboxView,await f.read()).textContent,/Beyond the loaded page/);
 }finally{await f.engine.dispose();}
});

test('one activity meter prefers the unified ledger and renders rolling plan inclusions',()=>{
 const work={enabled:true,period:'rolling-day',used:1250,limit:10000,hourUsed:100,hourLimit:2000};
 const root=render(billingView,{locale:'es',data:{storage:{...storage,writeOperations:{...work,used:9999}},work},billing:{plans:plans.map(plan=>({...plan,dailyActivityUnits:10000,hourlyActivityUnits:2000}))},config:{}});
 assert.equal(root.querySelectorAll('meter').length,2);assert.equal(root.querySelectorAll('.activity-allowance').length,1);assert.equal(root.querySelector('.activity-allowance meter').getAttribute('value'),'1250');assert.match(root.textContent,/Asignación de actividad/);assert.match(root.textContent,/Una acción puede utilizar más de una unidad/);assert.doesNotMatch(root.textContent,/ACTIVIDAD MENSUAL|cambios incluidos \/ mes/);assert.equal(root.querySelector('.plan-work'),null);assert.equal(root.querySelectorAll('.plan-activity').length,3);
 const absent=render(billingView,{locale:'en',data:{storage},billing:{plans},config:{}});assert.equal(absent.querySelector('.activity-allowance'),null);
});
test('unified exhausted allowance explains retained read and security access',()=>{const root=render(billingView,{locale:'es',data:{storage,work:{enabled:true,period:'rolling-day',used:1000,limit:1000,hourUsed:500,hourLimit:500}},billing:{plans:[]},config:{}});assert.equal(root.querySelectorAll('meter').length,2);assert.match(root.textContent,/Quedan 0 unidades de actividad/);assert.match(root.textContent,/aunque el tamaño almacenado no cambie/);assert.match(root.textContent,/controles de seguridad/);assert.equal(root.querySelector('.activity-allowance meter').getAttribute('value'),'1000');});
test('rolling-hour exhaustion is shown even with daily allowance remaining, and paid tiers display the same limits',()=>{for(const plan of ['plus','pro']){const root=render(billingView,{locale:'en',data:{storage:{...storage,plan},work:{enabled:true,period:'rolling-day',used:2500,limit:10000,hourUsed:2000,hourLimit:2000}},billing:{plans:[]},config:{}});assert.match(root.textContent,/2,500 of 10,000 activity units in the last 24 hours/);assert.match(root.textContent,/2,000 of 2,000 activity units in the last hour/);assert.match(root.textContent,/7,500 activity units available in the rolling 24-hour window/);assert.match(root.textContent,/until earlier activity leaves the rolling window/);assert.doesNotMatch(root.querySelector('.activity-allowance').textContent,/month|calendar|midnight/i);}});

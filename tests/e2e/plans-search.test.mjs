import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,screenshot} from './browser.mjs';

// Actual portal assets in Chrome, with explicit API fault injection. These
// fixtures verify UI behavior and do not claim provider or Worker conformance.
let browser;
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();});
const storage={plan:'free',planName:'Free',storageBytes:500000000,usedBytes:123450000,reservedBytes:2000000,remainingBytes:374550000,overLimit:false,messagesBytes:100000000,objectsBytes:23450000,messageCount:101,objectCount:4};
const plans=[{id:'free',name:'Free',storageBytes:500000000,annualAmount:0,currency:'usd'},{id:'plus',name:'Plus',storageBytes:5000000000,annualAmount:500,currency:'usd'},{id:'pro',name:'Pro',storageBytes:100000000000,annualAmount:3000,currency:'usd'}];
async function fixture(t,{locale='en',billing={plan:'free',enabled:false,configured:false,plans},storageOverride={},semantic=false}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1050},serviceWorkers:'block'});t.after(()=>context.close());
 await context.addInitScript(value=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale:value})),locale);
 const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&message.text()!=='Failed to load resource: the server responded with a status of 503 (Service Unavailable)'&&message.text()!=='Failed to load resource: the server responded with a status of 429 (Too Many Requests)'&&message.text()!=='Failed to load resource: net::ERR_INTERNET_DISCONNECTED')errors.push(message.text());});t.after(()=>assert.deepEqual(errors,[],'No browser runtime errors'));
 const account={id:'browser-owner',handle:'river',status:'active'};
 await page.route('**/api/config',route=>route.fulfill({json:{environment:'Plans/search browser fault injection',localDevelopment:true,semanticSearchEnabled:semantic,providers:{}}}));
 await page.route('**/api/session',route=>route.fulfill({json:{account,csrfToken:'fixture-csrf'}}));
 await page.route('**/api/account',route=>route.fulfill({json:{account,storage:{...storage,...storageOverride},collections:[{id:'inbox',name:'Inbox'}],messages:[],contacts:[],resources:[],rules:[],grants:[]}}));
 await page.route('**/api/billing',route=>route.fulfill({json:billing}));
 await page.goto(baseURL);await page.locator('.app-shell').waitFor();return {page,context};
}
test('localized storage meter and annual plan cards disable checkout without configuration and fit mobile',async t=>{
 const {page}=await fixture(t,{locale:'es',storageOverride:{writeOperations:{enabled:true,used:125,limit:1000,month:'2026-10',resetsAt:'2026-11-01T00:00:00Z'}}});let checkout=0;await page.route('**/api/billing/checkout',route=>{checkout++;return route.fulfill({status:503,json:{message:'unavailable'}});});
 await page.getByRole('button',{name:'Almacenamiento y facturación',exact:true}).click();await page.getByRole('heading',{name:'Almacenamiento y facturación'}).waitFor();
 await page.getByText(/planes de pago aún no están disponibles/).waitFor();assert.equal(await page.locator('.plan-card').count(),3);assert.equal(await page.getByText('500 MB',{exact:true}).count(),1);assert.equal(await page.getByText('5 GB',{exact:true}).count(),1);assert.equal(await page.getByText('100 GB',{exact:true}).count(),1);
 assert.ok((await page.locator('.plan-price').allTextContents()).some(price=>price.includes('5')&&price.includes('año')));assert.equal(await page.locator('.plan-card button:disabled').count(),3);assert.equal(checkout,0);
 assert.equal(await page.locator('.storage-panel meter').first().getAttribute('aria-label'),'Almacenamiento de la cuenta utilizado');
 await page.getByRole('meter',{name:'Escrituras mensuales de almacenamiento utilizadas'}).waitFor();await page.getByText('Quedan 875 escrituras de almacenamiento este mes',{exact:true}).waitFor();
 await screenshot(page,'plans-storage-es-desktop');
 for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`billing fits ${width}px`);}
 await screenshot(page,'plans-storage-es-mobile');
});
test('billing failure disables actions and an over-limit account keeps a clear read/export/delete explanation',async t=>{
 const {page}=await fixture(t,{storageOverride:{overLimit:true,usedBytes:600000000,remainingBytes:0}});
 await page.route('**/api/billing',route=>route.fulfill({status:503,json:{message:'Provider failed'}}));
 await page.getByRole('button',{name:'Storage & billing',exact:true}).click();await page.getByText('Plan information could not be loaded. Please try again.').waitFor();assert.ok(await page.getByText(/You can still read, export, and delete/).isVisible());assert.ok(await page.getByRole('button',{name:'Manage subscription',exact:true}).isDisabled());
});
test('full-space search preserves user language, cursor pages, index lag and reads content beyond the inbox page',async t=>{
 const {page}=await fixture(t,{locale:'es'});const queries=[];
 await page.route('**/api/search?*',route=>{const params=new URL(route.request().url()).searchParams;queries.push(Object.fromEntries(params));const second=params.has('cursor');return route.fulfill({json:{items:[{id:`message:${second?'older':'first'}`,source:{kind:'message',id:second?'older':'first'},type:'message',title:second?'Beyond the first 100 messages':'Inbox',snippet:'Free <script>keep user words</script>',tags:['Storage']}],cursor:second?null:'cursor-two',semanticAvailable:false,bounded:true,indexing:{pending:2,ready:false}}});});
 await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+f':'Control+Shift+f');await page.getByRole('heading',{name:'Buscar en tu espacio'}).waitFor();
 await page.getByLabel('Términos de búsqueda').fill('private phrase');await page.getByLabel('Etiqueta',{exact:true}).fill('owner-tag');await page.getByRole('button',{name:'Buscar todo el contenido',exact:true}).click();
 await page.getByRole('heading',{name:'Inbox',exact:true}).waitFor();assert.ok(await page.getByText('Free <script>keep user words</script>',{exact:true}).isVisible());assert.ok(await page.getByText(/índice de búsqueda se está actualizando/).isVisible());assert.equal(await page.locator('.search-results script').count(),0);assert.equal(queries[0].mode,'lexical');assert.equal(queries[0].tag,'owner-tag');
 await page.getByRole('button',{name:'Cargar más resultados',exact:true}).click();await page.getByRole('heading',{name:'Beyond the first 100 messages'}).waitFor();assert.equal(queries[1].cursor,'cursor-two');assert.equal(await page.locator('.search-result').count(),2);
 await screenshot(page,'omni-search-es-desktop');await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'search fits 320px');
 await page.route('**/api/messages/older',route=>route.fulfill({json:{message:{id:'older',title:'Beyond the first 100 messages',mimeType:'text/plain',text:'A message outside the loaded inbox',readAt:1},render:{kind:'text'}}}));
 await page.locator('.search-result').filter({has:page.getByRole('heading',{name:'Beyond the first 100 messages'})}).getByRole('button',{name:'Abrir mensaje'}).click();await page.getByText('A message outside the loaded inbox',{exact:true}).waitFor();
});
test('empty, API failure, and offline search states never show successful or stale content',async t=>{
 const {page,context}=await fixture(t);await page.getByRole('button',{name:'Search your space',exact:true}).first().click();
 await page.route('**/api/search?*',route=>route.fulfill({json:{items:[],cursor:null,indexing:{pending:0,ready:true}}}));
 await page.getByLabel('Search terms').fill('missing');await page.getByRole('button',{name:'Search all content',exact:true}).click();await page.getByRole('heading',{name:'No matches yet.'}).waitFor();
 await page.route('**/api/search?*',route=>route.fulfill({status:503,json:{message:'internal storage details'}}));await page.getByRole('button',{name:'Search all content',exact:true}).click();await page.getByText('Search could not be completed. Please try again.').waitFor();assert.equal(await page.getByText('internal storage details').count(),0);
 await context.setOffline(true);await page.getByText(/You’re offline/).waitFor();assert.equal(await page.locator('.search-result').count(),0);assert.equal(await page.getByText('123.45 MB').count(),0);
});

test('semantic opt-in explains remote processing, requires consent, routes chosen mode and clears results on revocation',async t=>{
 const {page}=await fixture(t,{semantic:true});let preference={configured:true,enabled:false,available:false,cleanupPending:false};const writes=[],queries=[];
 await page.route('**/api/search/preferences',route=>{if(route.request().method()==='PUT'){const value=route.request().postDataJSON();writes.push(value);preference={...preference,enabled:value.enabled,available:value.enabled,cleanupPending:!value.enabled};}return route.fulfill({json:preference});});
 await page.route('**/api/search?*',route=>{queries.push(new URL(route.request().url()).searchParams.get('mode'));return route.fulfill({json:{items:[],semanticAvailable:true,indexing:{ready:true}}});});
 await page.getByRole('button',{name:'Search your space',exact:true}).first().click();await page.getByText(/sends short excerpts and search queries/).waitFor();
 await page.getByLabel('Enable semantic search',{exact:true}).check();await page.getByRole('button',{name:'Save search preferences'}).click();await page.getByText('Review and agree to remote semantic processing before enabling it.',{exact:true}).waitFor();assert.equal(writes.length,0);
 await page.getByLabel('I agree to remote processing of my message excerpts and queries.',{exact:true}).check();await page.getByRole('button',{name:'Save search preferences'}).click();await page.getByLabel('Search mode',{exact:true}).selectOption('hybrid');await page.getByLabel('Search terms').fill('nearby ideas');await page.getByRole('button',{name:'Search all content',exact:true}).click();await page.getByRole('heading',{name:'No matches yet.'}).waitFor();assert.equal(queries.at(-1),'hybrid');
 await screenshot(page,'semantic-search-consent');await page.getByLabel('Enable semantic search',{exact:true}).uncheck();await page.getByRole('button',{name:'Save search preferences'}).click();await page.getByText('Remote vector cleanup is pending.',{exact:true}).waitFor();assert.deepEqual(writes,[{enabled:true},{enabled:false}]);assert.equal(await page.locator('.search-result').count(),0);assert.ok(await page.getByLabel('Enable semantic search',{exact:true}).isDisabled());
});

test('exhausted storage write allowance remains readable and rate faults never retry automatically',async t=>{const {page}=await fixture(t,{storageOverride:{writeOperations:{enabled:true,used:1000,limit:1000}}});await page.getByRole('button',{name:'Storage & billing',exact:true}).click();await page.getByText('Your monthly storage write allowance is used. New uploads and replacements pause until it resets. Reading and deleting remain available.',{exact:true}).waitFor();await page.getByText('Writes and replacements count even when storage size stays the same.',{exact:true}).waitFor();let requests=0;await page.route('**/api/resources',route=>{requests++;return route.fulfill({status:429,headers:{'Retry-After':'60'},json:{message:'Storage writes are arriving too quickly. Try again shortly.',retryAfter:60}});});await page.getByRole('button',{name:'Resources',exact:true}).click();await page.locator('.provider-card').filter({has:page.getByRole('heading',{name:'Extra hosted storage',exact:true})}).getByRole('button',{name:'Set up',exact:true}).click();await page.getByLabel('Connection name',{exact:true}).fill('Preserved connection draft');await page.getByRole('button',{name:'Save connection',exact:true}).click();await page.getByText('Storage writes are arriving too quickly. Try again shortly.',{exact:true}).first().waitFor();await page.waitForTimeout(250);assert.equal(requests,1);assert.equal(await page.getByLabel('Connection name',{exact:true}).inputValue(),'Preserved connection draft');assert.equal(await page.locator('.storage-writes meter').getAttribute('value'),'1000');});

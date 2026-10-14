import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,screenshot} from './browser.mjs';
let browser;test.before(async()=>browser=await launch());test.after(async()=>await browser?.close());
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t,{signedIn=true,configured=true}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});t.after(()=>context.close());
 const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.route('**/api/config',r=>r.fulfill({json:{origin:baseURL,localDevelopment:true,providers:{google:{enabled:configured}}}}));
 await page.route('**/api/session',r=>r.fulfill({json:{account:signedIn?{id:owner,handle:'river'}:null,csrfToken:'fixture'}}));
 await page.route('**/api/account',r=>r.fulfill({json:{account:{id:owner,handle:'river'},collections:[],messages:[],contacts:[],resources:[],rules:[],grants:[]}}));
 await page.route('**/api/integrations/google/**',r=>{calls.push({path:new URL(r.request().url()).pathname,body:r.request().postDataJSON()});return r.fulfill({json:calls.at(-1).path.endsWith('/start')?{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',expiresAt:Date.now()+600000}:{connected:true}});});
 return {page,calls};
}
test('Google setup fixture explains dedicated files, requires physical submit, and opens validated authorization',async t=>{
 const {page,calls}=await fixture(t);let navigation=false;await page.route('https://accounts.google.com/**',r=>{navigation=true;return r.fulfill({contentType:'text/html',body:'<h1>Google authorization fixture</h1>'});});
 await page.goto(baseURL+'/console');await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'Resources',exact:true}).click();
 await page.locator('.provider-card').filter({has:page.getByRole('heading',{name:'Google Drive',exact:true})}).getByRole('button',{name:'Set up',exact:true}).click();
 await page.getByRole('dialog').waitFor();await page.getByText('Authorize access to files created by this connection. Existing files in your Drive are not imported or listed.',{exact:true}).waitFor();
 await page.getByLabel('Connection name',{exact:true}).fill('Personal sync');
 await page.getByRole('button',{name:'Authorize with Google',exact:true}).evaluate(button=>button.click());await page.waitForTimeout(50);assert.equal(calls.length,0);
 await screenshot(page,'google-drive-setup-fixture');await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot(page,'google-drive-setup-mobile-fixture');
 await page.getByRole('button',{name:'Authorize with Google',exact:true}).click();await page.getByRole('heading',{name:'Google authorization fixture',exact:true}).waitFor();assert.ok(navigation);assert.deepEqual(calls[0],{path:'/api/integrations/google/start',body:{name:'Personal sync'}});
});
test('Google OAuth callback fixture consumes private authorization once and clears browser URL',async t=>{
 const {page,calls}=await fixture(t);await page.goto(baseURL+'/integrations/google/complete#state=opaque-state&code=private-code');
 await page.getByText('Google Drive connected. Apps can use files they create in this dedicated folder.',{exact:true}).waitFor();
 assert.equal(new URL(page.url()).hash,'');assert.deepEqual(calls,[{path:'/api/integrations/google/complete',body:{state:'opaque-state',code:'private-code'}}]);
 assert.doesNotMatch(await page.locator('body').innerText(),/opaque-state|private-code/);await page.getByRole('button',{name:'Messages',exact:true}).click();await page.waitForTimeout(50);assert.equal(calls.length,1);
});
test('Google OAuth return without session explains recovery and never posts code',async t=>{
 const {page,calls}=await fixture(t,{signedIn:false});await page.goto(baseURL+'/integrations/google/complete#state=opaque-state&code=private-code');
 await page.getByText('Sign in to finish Google Drive authorization. If this browser session changed, start a new connection from Resources.',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');assert.equal(calls.length,0);assert.doesNotMatch(await page.locator('body').innerText(),/opaque-state|private-code/);
});
test('Google reconnect fixture keeps selected resource identity and explains same-account authorization',async t=>{
 const {page,calls}=await fixture(t);const resource={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',provider:'google-drive',name:'Existing sync',status:'reauthorization_required'};
 await page.route('**/api/account',r=>r.fulfill({json:{account:{id:owner,handle:'river'},collections:[],messages:[],contacts:[],resources:[resource],rules:[],grants:[]}}));
 await page.route('https://accounts.google.com/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Google reconnect fixture</h1>'}));
 await page.goto(baseURL+'/console');await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'Resources',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Verify connection',exact:true}).count(),0);await page.getByRole('button',{name:'Reconnect Google Drive',exact:true}).click();
 await page.getByText('Authorize the same Google account to preserve this resource, its dedicated folder and its file mappings.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Connection name',{exact:true}).inputValue(),'Existing sync');
 await page.getByRole('button',{name:'Authorize with Google',exact:true}).click();await page.getByRole('heading',{name:'Google reconnect fixture',exact:true}).waitFor();assert.deepEqual(calls[0].body,{name:'Existing sync',resourceId:resource.id});
});

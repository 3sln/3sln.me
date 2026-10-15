import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,screenshot} from './browser.mjs';
// Real local Worker, real cookies and real identity sessions. Accounts are created
// through the same HTTP signup/recovery endpoints as the UI, inside the browser
// context's own cookie jar; only Turnstile uses the explicit local test token.
let browser;
test.before(async()=>{const url=new URL(baseURL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname),'local Worker required');const config=await (await fetch(`${baseURL}/api/config`)).json();assert.equal(config.localDevelopment,true);browser=await launch();});
test.after(async()=>{await browser?.close();});
async function signup(context,index){const headers={Origin:baseURL,'Content-Type':'application/json','CF-Connecting-IP':`198.51.100.${20+index+Math.floor(Math.random()*150)}`};const pending=await (await context.request.post(baseURL+'/api/auth/signup',{headers,data:{method:'password',password:'Multi account browser password 2026!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}})).json();assert.ok(pending.pendingToken,JSON.stringify(pending));const file=await (await context.request.post(baseURL+'/api/auth/recovery/download',{headers,data:{pendingToken:pending.pendingToken}})).json();const response=await context.request.post(baseURL+'/api/auth/recovery/confirm',{headers,data:{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true}});assert.equal(response.status(),200);return (await response.json()).account;}
const shell=(page,handle)=>page.locator('.user-summary strong').filter({hasText:handle}).waitFor();
const row=(page,handle)=>page.locator('.account-row').filter({hasText:handle+'@'});
test('real Worker console: switch, per-tab selection, cross-tab sign-out, notification destination, add account and sign out all',async t=>{
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'light'});t.after(()=>context.close());const errors=[];
 const accounts=[];for(let i=0;i<3;i++)accounts.push(await signup(context,i));const [one,two,three]=accounts;
 const cookies=(await context.cookies()).filter(c=>c.name.startsWith('bindle_'));assert.equal(cookies.filter(c=>/^bindle_account_[0-9a-f-]{36}$/.test(c.name)).length,3);assert(cookies.every(c=>c.httpOnly&&c.sameSite==='Strict'));
 const a=await context.newPage();a.on('pageerror',e=>errors.push(e.message));await a.goto(baseURL+'/console');await shell(a,three.handle);
 assert.equal(await a.evaluate(()=>document.cookie.includes('bindle_')),false,'member cookies are not script-readable');
 await a.getByRole('button',{name:'Switch account',exact:true}).click();await row(a,one.handle).waitFor();assert.equal(await row(a,three.handle).getByText('Current account').count(),1);
 await a.waitForFunction(()=>document.activeElement?.matches('.account-picker h1'));await screenshot(a,'multi-account-picker-light');
 const open=row(a,one.handle).getByRole('button',{name:'Open account',exact:true});await open.focus();await a.keyboard.press('Enter');await shell(a,one.handle);
 const b=await context.newPage();b.on('pageerror',e=>errors.push(e.message));await b.goto(baseURL+'/console');await shell(b,one.handle);
 await b.getByRole('button',{name:'Switch account',exact:true}).click();await row(b,two.handle).getByRole('button',{name:'Open account',exact:true}).click();await shell(b,two.handle);
 await a.reload();await shell(a,one.handle);assert.equal(await a.locator('.user-summary strong').filter({hasText:two.handle}).count(),0,'tab A keeps its own selection across reload');
 // Tab B signs out account one; tab A revalidates its own selector and blanks its private view.
 await b.getByRole('button',{name:'Switch account',exact:true}).click();await row(b,one.handle).getByRole('button',{name:'Sign out',exact:true}).click();await b.getByText('Signed out.').waitFor();await shell(b,two.handle).catch(()=>{});assert.equal(await row(b,one.handle).count(),0);
 await a.bringToFront();await a.evaluate(()=>window.dispatchEvent(new Event('focus')));await a.getByRole('heading',{name:'Accounts in this browser'}).waitFor();assert.equal(await a.locator('.user-summary').count(),0);
 // Notification destination: an inactive account is never read under the current one.
 const c=await context.newPage();c.on('pageerror',e=>errors.push(e.message));await c.goto(`${baseURL}/console?account=${three.id}&message=${crypto.randomUUID()}`);await row(c,three.handle).getByText('Notification account').waitFor();assert.equal(await c.locator('.user-summary').count(),0);
 await row(c,three.handle).getByRole('button',{name:'Open this message',exact:true}).click();await shell(c,three.handle);
 await c.getByRole('button',{name:'Switch account',exact:true}).click();await c.getByRole('button',{name:'Add account',exact:true}).click();await c.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();
 const inventory=await c.evaluate(async()=>(await (await fetch('/api/auth/accounts',{credentials:'same-origin'})).json()).accounts.map(x=>x.account.handle));assert.deepEqual(inventory.sort(),[two.handle,three.handle].sort(),'adding an account preserves other sessions');
 await c.getByRole('button',{name:'Accounts',exact:true}).click();await row(c,two.handle).waitFor();await c.getByLabel('Sign out of all accounts in this browser.').check();await c.getByRole('button',{name:'Sign out of all accounts',exact:true}).click();await c.getByText('No accounts are signed in in this browser.').waitFor();
 assert.equal((await context.cookies()).filter(x=>/^bindle_account_/.test(x.name)).length,0);assert.equal((await (await context.request.get(baseURL+'/api/session')).json()).authenticated,false);
 assert.deepEqual(errors,[]);
});
test('dark color scheme picker renders with the public dark tokens',async t=>{
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark'});t.after(()=>context.close());const first=await signup(context,7),second=await signup(context,8);const page=await context.newPage();await page.goto(baseURL+'/console');await shell(page,second.handle);
 await page.getByRole('button',{name:'Switch account',exact:true}).click();await row(page,first.handle).waitFor();await page.setViewportSize({width:390,height:844});
 const colors=await page.locator('.account-picker').evaluate(node=>({panel:getComputedStyle(node).backgroundColor,text:getComputedStyle(node.querySelector('strong')).color}));assert.notEqual(colors.panel,'rgb(255, 255, 255)');await screenshot(page,'multi-account-picker-dark-mobile');
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false,'no horizontal scroll at phone width');
});

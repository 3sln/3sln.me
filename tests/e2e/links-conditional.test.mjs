import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeServer} from '../../apps/node/server.mjs';
import {signSystemInvitation} from '../../packages/identity/system-bootstrap.mjs';
import {launch,screenshot} from './browser.mjs';

// Real Node identity/runtime + real Chromium. A local wrangler Worker cannot bootstrap the
// protected developer identity (it needs a configured email or push provider), so the
// developer-contact link and conditional opener flows run on the Node adapter with a
// loopback-only captured mailer. No debug routes are added.
const password='Private conditional browser password 2026!',secret=Buffer.alloc(32,61).toString('base64url');
let browser;const servers=[];
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();for(const s of servers){await s.app.close();await rm(s.directory,{recursive:true,force:true});}});
async function server(config={}){
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const origin='http://localhost:'+port,directory=await mkdtemp(join(tmpdir(),'3sln-links-browser-')),mailbox=[];
 const app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BRAND_NAME:'3sln.me',SIGNUP_ENABLED:'true',SYSTEM_BOOTSTRAP_KEY:secret,...config},mailer:{async sendSetupCode(value){mailbox.push(value);}}});
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));const entry={app,directory,origin,mailbox};servers.push(entry);
 // Operator bootstrap of the protected `ray` developer identity through the real public API.
 const post=(path,input,cookie)=>app.fetch(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.250',...cookie?{Cookie:cookie}:{}},body:JSON.stringify(input)}));
 const begin=await post('/api/auth/system/bootstrap/begin',{});const cookie=begin.headers.get('Set-Cookie').split(';')[0],now=Date.now();
 const token=await signSystemInvitation({version:1,purpose:'bindle-system-account-setup',issuer:origin,handle:'ray',role:'developer',owner:crypto.randomUUID(),assignmentId:crypto.randomUUID(),nonce:crypto.randomUUID(),issuedAt:now,expiresAt:now+3600000},secret);
 const pending=await (await post('/api/auth/system/bootstrap',{bootstrapToken:token,method:'password',password,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'},cookie)).json();assert.equal(pending.account.systemBadge.role,'developer');
 const file=await (await post('/api/auth/recovery/download',pending,cookie)).json();await post('/api/auth/setup/email/start',{...pending,email:'developer@links.example'},cookie);
 assert.equal((await post('/api/auth/setup/email/confirm',{...pending,code:mailbox.at(-1).code},cookie)).status,200);assert.equal((await post('/api/auth/recovery/confirm',{...pending,...file,downloadConfirmed:true},cookie)).status,200);
 // The scheduled census normally completes the active-population baseline; step it here so policy is decidable.
 for(let i=0;i<20&&!(await app.resources.population.censusStep()).complete;i++);
 return entry;
}
let network=10;
async function person(t,s,{signedIn=true}={}){
 const context=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{'CF-Connecting-IP':`198.51.100.${network++}`}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'No browser runtime errors'));
 let account=null;if(signedIn){const request=(path,data)=>context.request.post(s.origin+path,{headers:{Origin:s.origin},data});const pending=await (await request('/api/auth/signup',{method:'password',password,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'})).json(),recovery=await (await request('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json(),active=await request('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(active.status(),200,await active.text());account=(await active.json()).account;}
 return {context,page,account};
}
async function developerLink(page,s){await page.goto(s.origin+'/console');await page.locator('.app-shell').waitFor();return page.evaluate(async()=>{const session=await (await fetch('/api/session')).json();return (await fetch('/api/developer-contact',{headers:{'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext}})).json();});}

test('developer contact: eligible account sees the single conditional link, discloses before signing, then sends an authored message',async t=>{
 const s=await server(),alice=await person(t,s),signs=[];alice.page.on('request',request=>{if(request.url().endsWith('/api/links/respond'))signs.push(request.url());});
 const developer=await developerLink(alice.page,s);assert.equal(developer.available,true,JSON.stringify(developer));assert.deepEqual(developer.eligibility,{state:'eligible',tier:'free'});assert.match(developer.url,/\?bindle_meta=/);
 await alice.page.getByRole('button',{name:'Contact links',exact:true}).click();await alice.page.locator('.developer-eligibility.eligibility-eligible').waitFor();await screenshot(alice.page,'links-developer-contact-eligible');
 await alice.page.goto(developer.url);await alice.page.locator('section.contact-signed-in').getByRole('button',{name:'Send a message',exact:true}).click();
 await alice.page.locator('section.contact-handoff .contact-disclosure').waitFor();assert.match(await alice.page.locator('.contact-disclosure').textContent(),new RegExp(new URL(s.origin).host.replace('.','\\.')));assert.equal(signs.length,0,'nothing is signed before the click');assert.equal(/bindle|contact=/.test(new URL(alice.page.url()).search+new URL(alice.page.url()).hash),false);
 await screenshot(alice.page,'links-conditional-disclosure');
 await alice.page.locator('section.contact-handoff').getByRole('button',{name:/^Continue as /}).click();await alice.page.getByLabel('Your message').waitFor();assert.equal(signs.length,1);
 await alice.page.getByLabel('Subject').fill('Feedback on links');await alice.page.getByLabel('Your message').fill('Conditional links work for me.');await alice.page.locator('input[name=selectedTags][value="topic:feature"]').check();
 await alice.page.getByRole('button',{name:'Send message',exact:true}).click();await alice.page.locator('.contact-sent').getByText('Your message is on its way.').waitFor();await screenshot(alice.page,'links-conditional-eligible-sent');
 const ray=await s.app.resources.repository.findByHandle('ray'),stored=(await s.app.resources.accounts.get(ray.id).messages.list(ray.id)).find(m=>m.senderMetadata?.subject==='Feedback on links');assert.ok(stored);assert.deepEqual(stored.deliveryTags,['contact:developer','topic:feature','priority:free']);assert.equal(stored.delivery.author.principal.subject,alice.account.id);
 // Signed out: the same link offers sign-in or sign-up and signs nothing.
 const visitor=await person(t,s,{signedIn:false});await visitor.page.goto(developer.url);await visitor.page.locator('a.contact-intent').first().waitFor();await visitor.page.getByRole('button',{name:'Sign in or sign up with 3sln.me',exact:true}).waitFor();assert.equal(await visitor.page.locator('textarea').count(),0);
 const before=visitor.page.url();await visitor.page.locator('input[name=handle]').fill('someone@unreachable.example');await visitor.page.getByRole('button',{name:'Find my provider',exact:true}).click();await visitor.page.locator('[role=alert],.alert').first().waitFor();assert.equal(visitor.page.url(),before,'discovery failure never redirects');await visitor.page.locator('a.contact-intent').first().waitFor();await screenshot(visitor.page,'links-conditional-signed-out');
});

test('developer contact: when only paid accounts qualify, a free account sees a policy-level ineligible state and cannot send',async t=>{
 const s=await server({DEVELOPER_CONTACT_ACTIVE_THRESHOLD:'1'}),bob=await person(t,s),developer=await developerLink(bob.page,s);
 assert.equal(developer.available,true,JSON.stringify(developer));assert.equal(developer.eligibility.state,'ineligible');assert.equal(developer.eligibility.reason,'paid-required');
 await bob.page.goto(developer.url);await bob.page.locator('section.contact-signed-in').getByRole('button',{name:'Send a message',exact:true}).click();await bob.page.locator('section.contact-handoff').getByRole('button',{name:/^Continue as /}).click();await bob.page.locator('.contact-ineligible').waitFor();assert.match(await bob.page.locator('.contact-ineligible').textContent(),/paid accounts/);assert.equal(await bob.page.getByLabel('Your message').count(),0);
 await screenshot(bob.page,'links-conditional-ineligible');
 await bob.page.goto(s.origin+'/console');await bob.page.locator('.app-shell').waitFor();await bob.page.getByRole('button',{name:'Contact links',exact:true}).click();await bob.page.locator('.developer-eligibility.eligibility-ineligible').waitFor();await screenshot(bob.page,'links-developer-contact-ineligible');
});

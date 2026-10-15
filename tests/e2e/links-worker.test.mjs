import test from 'node:test';
import assert from 'node:assert/strict';
import {launch,baseURL,screenshot} from './browser.mjs';

// Real Chromium against the local Worker (wrangler.local.jsonc only): owner link issuance,
// tag labels, intake edits without reissue, and the signed-out → sign-in → authored send flow.
const password='Private links browser password 2026!';
let browser,network=40;
test.before(async()=>{const url=new URL(baseURL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname),'local Worker required');assert.equal((await (await fetch(`${baseURL}/api/config`)).json()).localDevelopment,true);browser=await launch();});
test.after(async()=>{await browser?.close();});
async function context(t){const value=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{'CF-Connecting-IP':`198.51.100.${network++}`}});t.after(()=>value.close());const page=await value.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'No browser runtime errors'));await page.route('https://challenges.cloudflare.com/**',route=>route.abort());return {context:value,page};}
// Account creation through the real identity API in the given cookie jar (no UI under test here).
async function signup(request){const post=(path,data)=>request.post(baseURL+path,{headers:{Origin:baseURL},data});const start=await post('/api/auth/signup',{method:'password',password,termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'});assert.equal(start.status(),200,await start.text());const pending=await start.json(),recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json(),active=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(active.status(),200,await active.text());return (await active.json()).account;}
const owner=(page,path,body,method='GET')=>page.evaluate(async({path,body,method})=>{const session=await (await fetch('/api/session')).json(),response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'X-Bindle-Account':session.account.id,'X-Bindle-Session-Context':session.sessionContext},...method==='GET'?{}:{body:JSON.stringify(body)}});return {status:response.status,body:await response.json()};},{path,body,method});

test('owner labels a tag, issues a new-form link and edits its intake without reissuing; signed-out opener signs in, returns and sends an authored message',async t=>{
 const {context:ownerContext,page}=await context(t);await signup(ownerContext.request);
 await page.goto(baseURL+'/console');await page.locator('.app-shell').waitFor();
 await page.getByRole('button',{name:'Rules',exact:true}).click();await page.locator('.tag-labels-panel').getByRole('button',{name:'New tag',exact:true}).click();
 await page.getByLabel('Label',{exact:true}).fill('Clients');await page.getByRole('button',{name:'Save label',exact:true}).click();await page.locator('.tag-labels-panel').getByText('Clients',{exact:true}).first().waitFor();await screenshot(page,'links-tag-labels');
 const labels=(await owner(page,'/api/tags/labels')).body,clients=Object.keys(labels.labels).find(id=>labels.labels[id]==='Clients');assert.match(clients,/^t\./);
 await page.getByRole('button',{name:'Contact links',exact:true}).click();await page.getByRole('button',{name:'New contact link',exact:true}).click();
 await page.getByLabel('Name this link').fill('Project inbox');await page.getByRole('button',{name:'Create contact link',exact:true}).click();
 const url=await page.getByLabel('Contact URL').inputValue();assert.match(url,/\/contact\/[a-f0-9-]{36}\?bindle_meta=/);await page.getByRole('button',{name:'Close dialog'}).click();
 const card=page.locator('.contact-card').filter({hasText:'Project inbox'});await card.getByRole('button',{name:'Edit tags',exact:true}).click();await page.getByRole('heading',{name:'Edit this link’s tags.'}).waitFor();
 await page.locator(`select[name="tag:${clients}"]`).selectOption('auto');await page.getByLabel('Other optional tags, separated by commas').fill('topic:bug');await screenshot(page,'links-intake-editor');
 await page.getByRole('button',{name:'Save tags',exact:true}).click();await page.getByText('Tags updated. Future messages use them; the link itself is unchanged.').waitFor();
 const listed=(await owner(page,'/api/account')).body.contacts.find(c=>c.name==='Project inbox');assert.deepEqual(listed.intake.autoTags,[clients]);assert.deepEqual(listed.intake.optionalTags,['topic:bug']);assert.equal((await owner(page,`/api/contacts/${listed.id}/url`)).body.url,url,'intake edits never reissue the link');
 // A separate cookie jar creates the sender; the opener starts signed out.
 const senderRequest=(await context(t)).context.request,sender=await signup(senderRequest);
 const {page:opener}=await context(t),signed=[];opener.on('request',request=>{if(request.url().includes('/api/links/'))signed.push(request.url());});
 await opener.goto(url);await opener.locator('a.contact-intent').first().waitFor();assert.equal(await opener.locator('textarea').count(),0,'the public page has no composer');
 assert.deepEqual(await opener.locator('a.contact-intent').evaluateAll(links=>links.map(a=>a.getAttribute('href'))),['send-message','add-contact'].map(intent=>`web+bindle://${intent}?contact-url=${encodeURIComponent(url)}`));
 assert.equal(new URL(opener.url()).search,'');assert.equal(signed.length,0);await screenshot(opener,'links-signed-out');
 await opener.locator('section.contact-signin').getByRole('button',{name:'Sign in or sign up with 3sln.me',exact:true}).click();
 await opener.getByRole('button',{name:'Sign in with password',exact:true}).click();await opener.getByLabel('Your handle',{exact:true}).fill(sender.handle);await opener.getByLabel('Password',{exact:true}).fill(password);await opener.locator('.auth-card form').getByRole('button',{name:'Sign in with password',exact:true}).click();
 const handoff=opener.locator('section.contact-handoff');await handoff.waitFor();assert.equal(signed.length,0,'returning never signs or sends without a click');assert.equal(/bindle|sig=|contact/.test(new URL(opener.url()).search+new URL(opener.url()).hash),false,'no capability in the address bar');
 if(await handoff.getByRole('button',{name:'Send a message',exact:true}).count())await handoff.getByRole('button',{name:'Send a message',exact:true}).click();
 await opener.getByLabel('Subject').fill('Project question');await opener.getByLabel('Your message').fill('Hello from an identity-authored sender.');await opener.locator('input[name=selectedTags][value="topic:bug"]').check();await screenshot(opener,'links-console-composer');
 await opener.getByRole('button',{name:'Send message',exact:true}).click();await opener.locator('.contact-sent').getByText('Your message is on its way.').waitFor();await screenshot(opener,'links-authored-sent');
 // A signed-in viewer of the public page is offered the console handoff, not a composer.
 await opener.goto(url);await opener.locator('section.contact-signed-in').getByRole('button',{name:'Add to contacts',exact:true}).waitFor();assert.equal(await opener.locator('section.contact-signin').count(),0);await screenshot(opener,'links-signed-in-handoff');
 const incoming=(await owner(page,'/api/messages/page?limit=10')).body.items,message=incoming.find(item=>item.senderMetadata?.subject==='Project question');assert.ok(message,'message delivered');assert.deepEqual(message.deliveryTags,[clients,'topic:bug']);
 await page.getByRole('button',{name:'Messages',exact:true}).first().click();await page.reload();await page.locator('.app-shell').waitFor();await page.locator('.pill',{hasText:'Clients'}).first().waitFor();await screenshot(page,'links-owner-tag-pills');
});

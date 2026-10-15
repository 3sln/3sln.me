// Real-browser walkthrough of host administration against a running local
// Worker or Node server with the admin routes mounted. Needs a fresh boot token
// for this exact origin (E2E_BOOT_TOKEN, or E2E_BOOT_TOKEN_FILE from
// scripts/boot-token.mjs) and a configured ONBOARDING_KEY; skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launch,baseURL,virtualAuthenticator,screenshot} from './browser.mjs';
const bootToken=process.env.E2E_BOOT_TOKEN||(process.env.E2E_BOOT_TOKEN_FILE?JSON.parse(readFileSync(process.env.E2E_BOOT_TOKEN_FILE,'utf8')).token:'');
export const shimmed=[];
const BOOT_PASSWORD='correct horse battery staple boot';
async function probe(){try{const response=await fetch(baseURL+'/api/admin/boot/status',{method:'POST',headers:{Origin:baseURL,'Content-Type':'application/json','X-Bindle-Admin-Actor':'boot'},body:'{}'});if(!response.ok)return null;return await response.json();}catch{return null;}}
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
/** Claims an invited name through the real token-onboarding UI with a passkey,
 * then finishes recovery through the same public setup endpoints the UI uses. */
async function claimThroughOnboarding(browser,link,name){
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();await virtualAuthenticator(context,page);
 // Shim, only while /api/config still derives tokenOnboardingEnabled from static
 // ONBOARDING_ENABLED alone (pending http.mjs hunk: `||env.ADMIN_CLAIMS_ENABLED===true`).
 // The server-side onboarding gate already admits admin-minted claims.
 await page.route(baseURL+'/api/config',async route=>{try{const response=await route.fetch(),config=JSON.parse(await response.text());if(config.tokenOnboardingEnabled!==true){shimmed.push(name);config.tokenOnboardingEnabled=true;}await route.fulfill({status:response.status(),headers:response.headers(),body:JSON.stringify(config)});}catch{await route.continue().catch(()=>{});}});
 await page.goto(link);await page.getByRole('button',{name:'Use invitation',exact:true}).click();
 await page.selectOption('[name=onboardingName]',name);await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('button',{name:'Passkey',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
 for(let step=0;step<6;step++){const create=page.getByRole('button',{name:'Create my account',exact:true}),terms=page.locator('[name=termsAccepted]');await create.or(terms).first().waitFor();if(await create.count())break;await terms.check();await page.getByRole('button',{name:'Continue',exact:true}).click();await terms.waitFor({state:'detached'});}
 await page.getByRole('button',{name:'Create my account',exact:true}).click();await page.waitForURL(/\/recovery\/setup/);
 const pendingToken=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('3sln-setup')??'null')?.token);assert.ok(pendingToken,'onboarding produced a pending setup');
 const post=(path,data)=>context.request.post(baseURL+path,{headers:{Origin:baseURL},data});
 const file=await (await post('/api/auth/recovery/download',{pendingToken})).json();const done=await post('/api/auth/recovery/confirm',{pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true});assert.equal(done.status(),200);
 return {context,page,session:await done.json()};
}
test('boot setup, administrator step-up, reservation, claim, onboarding and audit in a real browser',async t=>{
 const status=await probe();
 if(!bootToken||!status?.configured||status.token!=='unused'){t.skip('Admin routes, an unused boot token for this origin and ONBOARDING_KEY are required.');return;}
 const browser=await launch();t.after(async()=>{if(process.env.E2E_DEBUG){let i=0;for(const context of browser.contexts())for(const page of context.pages())await page.screenshot({path:`${process.env.E2E_ARTIFACTS}/admin-debug-${i++}.png`,fullPage:true}).catch(()=>{});}await browser.close();});
 // ---- boot ----
 const bootContext=await browser.newContext({viewport:{width:1280,height:900}}),boot=await bootContext.newPage(),errors=[],scripts=[];
 boot.on('pageerror',error=>errors.push(error.message));
 await boot.goto(baseURL+'/console?boot');await boot.getByRole('heading',{name:'Set up boot access'}).waitFor();
 await boot.getByLabel('Boot token',{exact:true}).fill(bootToken);await boot.getByRole('button',{name:'Check token',exact:true}).click();
 await boot.getByRole('heading',{name:'Claim boot access'}).waitFor();
 assert.equal(boot.url().includes(bootToken.slice(6,30)),false);assert.equal((await boot.locator('body').innerText()).includes(bootToken),false);assert.equal(await boot.getByLabel('Boot token',{exact:true}).count(),0);
 await boot.getByRole('radio',{name:/Password/}).check();await boot.getByLabel('Boot password',{exact:true}).fill(BOOT_PASSWORD);await boot.getByLabel('Repeat the password',{exact:true}).fill(BOOT_PASSWORD);
 await screenshot(boot,'admin-boot-setup');
 await boot.getByRole('button',{name:'Claim boot',exact:true}).click();
 assert.equal(await boot.getByRole('heading',{name:'Overview'}).count(),0,'the mandatory acknowledgement blocks completion');
 await boot.getByRole('checkbox',{name:/I understand boot access ends/}).check();await boot.getByRole('button',{name:'Claim boot',exact:true}).click();
 await boot.getByRole('heading',{name:'Overview'}).waitFor();await boot.getByRole('timer',{name:/Boot access ends in \d+ h/}).waitFor();
 await screenshot(boot,'admin-boot-overview');
 // Reload keeps the boot session (HttpOnly cookie) and restores CSRF without re-entering the token.
 await boot.reload();await boot.getByRole('heading',{name:'Overview'}).waitFor();
 const nav=name=>boot.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name,exact:true}).click();
 await nav('Reservations');await boot.getByLabel('Handle',{exact:true}).fill('ops-lead');await boot.getByRole('checkbox',{name:/^Administrator/}).check();await boot.getByRole('button',{name:'Save reservation',exact:true}).click();await boot.getByText('Reservation saved.').waitFor();
 await nav('Claims');await boot.getByLabel('Reserved handle',{exact:true}).fill('ops-lead');await boot.getByRole('button',{name:'Mint claim token',exact:true}).click();
 await boot.getByRole('alertdialog',{name:'Mint an administrator claim?'}).waitFor();await boot.getByRole('button',{name:'Mint administrator claim',exact:true}).click();
 const adminLink=await boot.getByLabel('Claim link',{exact:true}).inputValue();assert.match(adminLink,new RegExp('^'+baseURL.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/token-onboarding#token=bo1\\.'));
 await screenshot(boot,'admin-claim-reveal');
 await nav('Overview');await boot.getByRole('heading',{name:'Overview'}).waitFor();await nav('Claims');await boot.getByRole('heading',{name:'Claims',exact:true}).first().waitFor();assert.equal(await boot.getByLabel('Claim link',{exact:true}).count(),0,'a revealed link is shown once');
 await nav('Roles & capabilities');await boot.getByRole('button',{name:'Add capability',exact:true}).click();await boot.getByLabel('Identifier',{exact:true}).fill('support.read');await boot.getByLabel('Class',{exact:true}).selectOption('user');await boot.getByLabel('Description',{exact:true}).fill('Read support tickets.');await boot.getByRole('button',{name:'Add capability',exact:true}).last().click();await boot.getByText('Role catalog saved.').waitFor();
 await screenshot(boot,'admin-roles-boot');
 // ---- administrator ----
 const admin=await claimThroughOnboarding(browser,adminLink,'ops-lead');admin.page.on('pageerror',error=>errors.push(error.message));
 admin.page.on('request',request=>{if(request.resourceType()==='script')scripts.push(request.url());});
 await admin.page.goto(baseURL+'/console?admin');await admin.page.getByRole('dialog',{name:'Confirm it’s you'}).waitFor();
 assert.equal(await admin.page.getByLabel('Boot password').count(),0,'administrators are offered a passkey only');
 await screenshot(admin.page,'admin-step-up');
 await admin.page.getByRole('button',{name:'Confirm with passkey',exact:true}).click();await admin.page.getByRole('heading',{name:'Overview'}).waitFor();
 await admin.page.getByRole('heading',{name:/Boot was restored recently|Boot access is active/}).waitFor();
 await screenshot(admin.page,'admin-overview');
 const adminNav=name=>admin.page.getByRole('navigation',{name:'Administration sections'}).getByRole('button',{name,exact:true}).click();
 await adminNav('Roles & capabilities');assert.equal(await admin.page.getByRole('button',{name:'Add capability'}).count(),0);assert.equal(await admin.page.getByRole('combobox',{name:'Class of support.read'}).isDisabled(),true);await admin.page.getByText('Boot only').first().waitFor();
 await screenshot(admin.page,'admin-roles-admin');
 await adminNav('Reservations');await admin.page.getByLabel('Handle',{exact:true}).fill('night-desk');assert.equal(await admin.page.getByRole('checkbox',{name:/^Administrator/}).isDisabled(),true);await admin.page.getByRole('button',{name:'Save reservation',exact:true}).click();await admin.page.getByText('Reservation saved.').waitFor();
 await adminNav('Claims');await admin.page.getByLabel('Reserved handle',{exact:true}).fill('night-desk');await admin.page.getByRole('button',{name:'Mint claim token',exact:true}).click();
 const deskLink=await admin.page.getByLabel('Claim link',{exact:true}).inputValue();
 const desk=await claimThroughOnboarding(browser,deskLink,'night-desk');await desk.context.close();
 await adminNav('Users');await admin.page.getByLabel('Value',{exact:true}).fill('night-desk');await admin.page.getByRole('button',{name:'Look up',exact:true}).click();await admin.page.getByText('Internal · claim').waitFor();
 await adminNav('Audit log');await admin.page.getByText('Chain intact').waitFor();await admin.page.getByText('claim.mint').first().waitFor();await admin.page.getByRole('button',{name:'Verify entire chain',exact:true}).click();await admin.page.getByText(/Every entry through \d+ links/).waitFor();
 await screenshot(admin.page,'admin-audit');
 await admin.page.setViewportSize({width:390,height:844});assert.equal(await noOverflow(admin.page),true,'no horizontal page scroll at phone width');await screenshot(admin.page,'admin-audit-mobile');
 assert.ok(scripts.some(url=>/admin-console\.[A-Za-z0-9_-]+\.mjs/.test(url)),'the operations module loads only after access');
 // ---- dark mode, ordinary accounts ----
 const dark=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'}),darkPage=await dark.newPage();await darkPage.goto(baseURL+'/console?boot');await darkPage.getByRole('heading',{name:/Sign in as boot|Boot token already used/}).waitFor();assert.equal(await noOverflow(darkPage),true);await screenshot(darkPage,'admin-boot-signin-dark');await dark.close();
 const ordinary=await browser.newContext({viewport:{width:1280,height:900}}),post=(path,data)=>ordinary.request.post(baseURL+path,{headers:{Origin:baseURL},data});const config=await (await ordinary.request.get(baseURL+'/api/config')).json();
 const pending=await (await post('/api/auth/signup',{method:'password',password:'ordinary account password!',termsAccepted:true,termsVersion:config.termsVersion,turnstileToken:'local-browser-test-token'})).json();
 if(pending.pendingToken){const file=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true});
  const page=await ordinary.newPage(),loaded=[];page.on('request',request=>loaded.push(request.url()));
  await page.goto(baseURL+'/console');await page.locator('.app-shell').waitFor();assert.equal(loaded.some(url=>/admin-/.test(url)),false,'the ordinary console never loads administration code');
  await page.goto(baseURL+'/console?admin');await page.getByRole('heading',{name:'Not available for this account'}).waitFor();assert.equal(loaded.some(url=>/admin-console\./.test(url)),false,'ordinary accounts never load the operations module');}
 await ordinary.close();
 // ---- boot ends its own access ----
 await nav('Overview');await boot.getByRole('button',{name:'End boot access now…',exact:true}).click();await boot.getByRole('alertdialog',{name:'End boot access now?'}).waitFor();await boot.getByRole('button',{name:'End boot access',exact:true}).click();
 const confirmIfAsked=boot.getByRole('dialog',{name:'Confirm it’s you'});if(await confirmIfAsked.isVisible().catch(()=>false)){await boot.getByLabel('Boot password',{exact:true}).fill(BOOT_PASSWORD);await boot.getByRole('button',{name:'Confirm with password',exact:true}).click();}
 await boot.getByRole('heading',{name:'Boot access ended early'}).waitFor();await screenshot(boot,'admin-boot-ended');
 assert.deepEqual(errors,[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch,baseURL,waitForApp,screenshot} from './browser.mjs';
import {verifyNameAssignment} from '../../packages/recovery/identity-backup.mjs';

test('actual Worker public name certificate downloads separately and canonical Crockford login preserves identity',async t=>{
 const browser=await launch();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const config=await (await context.request.get(baseURL+'/api/config')).json();
 const post=(path,data)=>context.request.post(baseURL+path,{headers:{Origin:baseURL},data});
 const password='Browser identity certificate test password!';
 const start=await post('/api/auth/signup',{method:'password',password,termsAccepted:true,termsVersion:config.termsVersion,turnstileToken:'local-browser-test-token'});assert.equal(start.status(),200);
 const pending=await start.json();assert.match(pending.account.handle,/^n\.[0-9abcdefghjkmnpqrstvwxyz]+$/);
 const file=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();const backup=JSON.parse(file.content);assert.equal(backup.handle,undefined);assert.equal(backup.nameAssignment,undefined);
 const activated=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true});assert.equal(activated.status(),200);const session=await activated.json();
 const page=await context.newPage();await page.goto(baseURL);await waitForApp(page);await page.getByRole('button',{name:'Account & security',exact:true}).click();
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download canonical name certificate'}).click();const download=await downloading;
 const cert=JSON.parse(await readFile(await download.path(),'utf8'));const authority=await (await context.request.get(baseURL+'/api/recovery/authority')).json();
 await verifyNameAssignment(cert,authority,{issuer:baseURL,entity:session.account.id,handle:session.account.handle});assert.equal(cert.keychain,undefined);assert.equal(cert.recoveryToken,undefined);
 await page.getByLabel('Custom handle',{exact:true}).fill('123');await page.getByRole('checkbox',{name:'I understand this is my one permanent custom handle.'}).check();await page.getByRole('button',{name:'Claim permanent handle',exact:true}).click();
 await page.getByText('Billing is not enabled.',{exact:true}).waitFor();assert.equal((await (await context.request.get(baseURL+'/api/session')).json()).account.paidHandle,null);
 await screenshot(page,'identity-names-desktop');await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot(page,'identity-names-mobile');
 await page.getByRole('button',{name:'Sign out',exact:true}).first().click();await page.getByRole('button',{name:'Password',exact:true}).click();await page.getByLabel('Your handle',{exact:true}).fill(session.account.handle.toUpperCase());await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'A home worth protecting.'}).waitFor();const logged=await (await context.request.get(baseURL+'/api/session')).json();assert.equal(logged.account.id,session.account.id);assert.equal(logged.account.handle,session.account.handle);
});

test('canceling provider-signature verification prevents late backup completion and KDF work',async t=>{
 const browser=await launch();t.after(()=>browser.close());const context=await browser.newContext();const page=await context.newPage();await page.goto(baseURL);
 let signalRequest;const requested=new Promise(resolve=>signalRequest=resolve);let releaseResponse;const held=new Promise(resolve=>releaseResponse=resolve);
 await page.route('**/api/recovery/authority',async route=>{signalRequest();await held;await route.abort().catch(()=>{});});
 await page.evaluate(async()=>{
  const {default:RecoveryProvider}=await import('/src/providers/recovery-file.mjs');const {generateIdentityKeychain,createIdentityBackup}=await import('/packages/recovery/identity-backup.mjs');
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const entity=crypto.randomUUID();
  const backup=await createIdentityBackup({issuer:location.origin,entity,keychain:await generateIdentityKeychain(),recoveryToken:entity+'.'+'x'.repeat(43),warning:'Private test backup.'},{kid:crypto.randomUUID(),privateKey:pair.privateKey});
  const provider=new RecoveryProvider();window.cancelRecovery=await provider.obtain();
  const NativeWorker=window.Worker;window.recoveryWorkerStarts=0;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.recoveryWorkerStarts++;}};
  window.pendingRecovery=window.cancelRecovery.encrypt(backup,[{id:'phrase',type:'passphrase',prompt:'Private passphrase'}],['Strong private test passphrase'],location.origin).then(()=>({completed:true}),()=>({canceled:true}));
 });
 await requested;await page.evaluate(()=>window.cancelRecovery.cancel());releaseResponse();assert.deepEqual(await page.evaluate(()=>window.pendingRecovery),{canceled:true});assert.equal(await page.evaluate(()=>window.recoveryWorkerStarts),0);
});

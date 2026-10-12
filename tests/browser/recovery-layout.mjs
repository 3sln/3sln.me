import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch,baseURL,screenshot} from '../e2e/browser.mjs';

test('recovery questions preserve native answers through reorder, fit mobile, and localize interface without changing public metadata',async()=>{
 assert.ok(['localhost','127.0.0.1'].includes(new URL(baseURL).hostname));
 const browser=await launch();try{
  const context=await browser.newContext({acceptDownloads:true,extraHTTPHeaders:{'CF-Connecting-IP':`198.51.100.${Math.floor(Math.random()*200)+20}`}});
  const handle=`layout_${Date.now().toString(36)}`;
  const response=await context.request.post(`${baseURL}/api/auth/signup`,{headers:{Origin:baseURL},data:{handle,method:'password',password:'Layout test password2026!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}});
  assert.equal(response.status(),200);const {pendingToken}=await response.json();
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({pendingToken})=>{sessionStorage.setItem('3sln-setup',JSON.stringify({token:pendingToken,stage:'recovery'}));},{pendingToken});
  await page.goto(`${baseURL}/recovery/setup`);await page.getByRole('heading',{name:'Keep a way back in.'}).waitFor();
  const first=page.locator('.recovery-question').first();await first.locator('input[name^="answer:"]').fill('Private first answer 2026');
  await page.getByRole('button',{name:'Add a question',exact:true}).click();
  const second=page.locator('.recovery-question').nth(1);await second.getByLabel('Question',{exact:true}).fill('Resources');await second.getByLabel('Public hint (optional)').fill('Sign in');await second.locator('input[name^="answer:"]').fill('Private second answer 2026');
  await second.getByRole('button',{name:'Move up',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.recovery-question input[name^="prompt:"]').value==='Resources');
  assert.equal(await page.locator('.recovery-question').first().getByLabel('Question',{exact:true}).inputValue(),'Resources');
  assert.equal(await page.locator('.recovery-question').first().locator('input[name^="answer:"]').inputValue(),'Private second answer 2026');
  assert.equal(await page.locator('.recovery-question').nth(1).locator('input[name^="answer:"]').inputValue(),'Private first answer 2026');
  for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await screenshot(page,`encrypted-recovery-questions-mobile-${width}`);}
  await page.setViewportSize({width:1440,height:1100});await screenshot(page,'encrypted-recovery-questions-desktop');
  await page.getByRole('button',{name:'Encrypt recovery file',exact:true}).click();await page.getByRole('heading',{name:'Save your encrypted recovery file.'}).waitFor();await screenshot(page,'encrypted-recovery-download-desktop');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download recovery file',exact:true}).click();const saved=await download;const encrypted=await readFile(await saved.path());await page.getByRole('heading',{name:'Test your recovery answers.'}).waitFor();await screenshot(page,'encrypted-recovery-verify-desktop');
  await page.getByLabel('Resources',{exact:true}).fill('Private second answer 2026');await page.getByLabel('What is my private recovery passphrase?',{exact:true}).fill('Private first answer 2026');await page.getByRole('button',{name:'Test unlock',exact:true}).click();await page.getByRole('heading',{name:'Your way back in is ready.'}).waitFor();await screenshot(page,'encrypted-recovery-confirm-desktop');
  await page.evaluate(()=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale:'es',keybindingOverrides:[]})));await page.reload();await page.getByRole('heading',{name:'Conserva una forma de volver.'}).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'es');assert.equal(await page.locator('.recovery-question input[name^="prompt:"]').inputValue(),'¿Cuál es mi frase secreta privada de recuperación?');await screenshot(page,'encrypted-recovery-questions-spanish');
  await page.goto(`${baseURL}/recovery/restore`);await page.locator('input[type=file]').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:encrypted});await page.getByRole('button',{name:'Leer las preguntas de recuperación',exact:true}).click();await page.getByLabel('Resources',{exact:true}).waitFor();assert.equal(await page.getByText('Sign in',{exact:true}).count(),1);assert.equal(await page.getByText('Recursos',{exact:true}).count(),0);await screenshot(page,'encrypted-recovery-restore-spanish');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

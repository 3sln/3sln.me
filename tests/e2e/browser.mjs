import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const baseURL=process.env.E2E_BASE_URL || 'http://localhost:8787';
export const artifacts=path.resolve(process.env.E2E_ARTIFACTS || '/tmp/3sln-e2e');
mkdirSync(artifacts,{recursive:true});
export async function launch(options={}){
  const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const pinnedChrome=chromium.executablePath();
  const executablePath=process.env.E2E_CHROME || (existsSync(pinnedChrome)?undefined:existsSync(localChrome)?localChrome:undefined);
  return chromium.launch({...options,headless:true,executablePath});
}
export async function virtualAuthenticator(context,page){
  const cdp=await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  return {cdp,authenticatorId};
}
export async function waitForApp(page){
  await page.goto(baseURL+'/console');
  await page.locator('.auth-card,.app-shell').first().waitFor();
}
export async function screenshot(page,name){await page.evaluate(async()=>{await document.fonts.ready;if(document.activeElement?.matches('.skip-link'))document.activeElement.blur();window.scrollTo({top:0,left:0,behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(artifacts,`${name}.png`),fullPage:true,animations:'disabled'});}
export async function publicAssetCache(page){
  return page.evaluate(async()=>{
    const names=await caches.keys();const urls=[];
    for(const name of names)for(const request of await (await caches.open(name)).keys())urls.push(request.url);
    return urls;
  });
}

// Traverse actual public signup questions; this does not create or activate an account.
export async function completeSignupQuestions(page,{email,channel='email'}={}){
 for(let count=0;count<8;count++){
  const card=page.locator('.signup-wizard');await card.waitFor();
  if(await card.getByRole('button',{name:/^(Create my account|Crear mi cuenta)$/,exact:true}).count())return;
  const heading=await card.locator('.wizard-heading').textContent();
  if(await card.getByRole('button',{name:/^(Use email|Usar correo)$/,exact:true}).count())await card.getByRole('button',{name:channel==='push'?/^(Use notifications|Usar notificaciones)$/:/^(Use email|Usar correo)$/,exact:true}).click();
  if(await card.locator('input[name=noticeEmail]').count()){if(!email)throw new Error('Signup fixture requires an email for the selected contact channel');await card.locator('input[name=noticeEmail]').fill(email);}
  if(await card.locator('input[name=termsAccepted]').count())await card.locator('input[name=termsAccepted]').check();
  await card.getByRole('button',{name:/^(Continue|Continuar)$/,exact:true}).click();
  await page.waitForFunction(previous=>document.querySelector('.signup-wizard .wizard-heading')?.textContent!==previous,heading);
 }
 throw new Error('Signup questions did not reach the credential screen');
}

// Source-only Chromium fixture; no generated assets, external services or real accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {launch} from './browser.mjs';
const origin='https://onboarding.example',token='bo1.e30.'+'A'.repeat(43),root=resolve('.');
test('Chromium private link scrubs before app load, selects only invited name and enters ordinary setup',async()=>{
 const browser=await launch();
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'No external resource is requested');assert(!request.url().includes(token));assert(!(request.headers().referer??'').includes(token));
  const send=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname.startsWith('/api/')){
   const body=request.postDataJSON();calls.push({path:url.pathname,body});
   if(url.pathname==='/api/config')return send({origin,brand:{name:'Private Space',host:'onboarding.example'},signupEnabled:false,tokenOnboardingEnabled:true,localDevelopment:true,signupContactRequired:false,deviceLoginEnabled:false});
   if(url.pathname==='/api/session')return send({authenticated:false});
   if(url.pathname==='/api/signup/status')return send({signupEnabled:false,freeSignupOpen:false,paidSignupOpen:false,reason:'disabled'});
   if(url.pathname==='/api/auth/onboarding/begin')return send({ready:true});
   if(url.pathname==='/api/auth/onboarding/inspect')return send({issuer:origin,expiresAt:Date.now()+60000,names:[{name:'alice',status:'available'},{name:'bob',status:'claimed'}]});
   if(url.pathname==='/api/auth/onboarding/claim')return send({pendingToken:'limited-private-setup',account:{handle:'n.abc',status:'pending'},readyForRecovery:true});
   if(url.pathname==='/api/auth/setup/status')return send({accountId:'owner',channelRequired:false,channelVerified:false});
   return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Fixture stops before private recovery generation.'})});
  }
  if(['/token-onboarding','/console','/recovery/setup'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/apps/web/styles.css"></head><body><div id="app"></div><script type="module" src="/src/main.mjs"></script></body></html>'});
  let relative=url.pathname.startsWith('/src/')?'apps/web'+url.pathname:url.pathname.slice(1);const file=resolve(root,relative);if(!file.startsWith(root+'/'))return route.abort();
  try{if(!(await stat(file)).isFile())return route.abort();let body=await readFile(file);if(relative==='apps/web/src/release.mjs')body=Buffer.from('if(location.hash)throw Error("Capability was not scrubbed before app evaluation");\n'+body);return route.fulfill({contentType:['.mjs','.js'].includes(extname(file))?'text/javascript':'.css'===extname(file)?'text/css':'application/octet-stream',body});}catch{return route.fulfill({status:404,body:''});}
 });
 try{
  await page.goto(origin+'/token-onboarding?plan=paid#token='+token);
  await page.getByRole('button',{name:'Use invitation',exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash,'');assert.equal(new URL(page.url()).search,'');assert.equal(calls.some(c=>c.path.endsWith('/inspect')),false);
  await page.getByRole('button',{name:'Use invitation',exact:true}).click();
  await page.getByRole('combobox',{name:'Account name'}).waitFor();
  assert.deepEqual(await page.locator('[name=onboardingName] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','alice']);
  await page.selectOption('[name=onboardingName]','alice');assert(!(await page.locator('body').innerText()).includes(token));assert.equal(await page.locator('[name=password],[name=onboardingToken]').count(),0);await mkdir('artifacts/browser',{recursive:true});await page.screenshot({path:'artifacts/browser/private-onboarding-names.png'});await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Password',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.locator('[name=termsAccepted]').check();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.locator('[name=password]').fill('a long private password');await page.getByRole('button',{name:'Create my account',exact:true}).click();
  await page.waitForURL(origin+'/recovery/setup');
  const claim=calls.find(c=>c.path.endsWith('/claim'));assert.equal(claim.body.name,'alice');assert.equal(claim.body.onboardingToken,token);assert.equal(claim.body.signupPlan,undefined);
  assert.equal(await page.evaluate(t=>JSON.stringify({...sessionStorage,...localStorage}).includes(t),token),false);
  await page.evaluate(()=>sessionStorage.clear());await page.goto(origin+'/console?signin');await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/Create.*account/}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

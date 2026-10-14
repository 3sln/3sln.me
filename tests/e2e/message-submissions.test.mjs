import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeServer} from '../../apps/node/server.mjs';
import {launch,screenshot,artifacts} from './browser.mjs';

const appOrigin='https://bindle-client.example',fragment='https://3sln.me/artefacts/preferences/app-messages/v1',contract='https://3sln.me/artefacts/contracts/app-messages/v1';
const encode=value=>new TextEncoder().encode(value);
// Only mail and external form transport are local resource ports. Signup,
// consent, signed app intake, owner sessions, broker HTTP and SQLite are real.
let app,browser,directory,origin;const mail=[],sends=[],dispatches=[],preparations=[];
const modes={
 status:{status:200,headers:{contentType:'application/vnd.bindle.submission-status+json'},bytes:encode(JSON.stringify({type:'info',message:'Saved <b>literally</b>',actions:[{label:'Help <img src=x>',href:'https://help.example/answer'},{label:'Details',href:appOrigin+'/details'}]}))},
 error:{status:403,headers:{contentType:'application/vnd.bindle.submission-status+json'},bytes:encode(JSON.stringify({type:'success',message:'Payment refused',actions:[{label:'Help',href:'https://help.example/answer'}]}))},
 html:{status:200,headers:{contentType:'text/html'},bytes:encode('<h1>Retained local result</h1><p>Original remains available.</p><img src="https://tracker.example/returned"><script>parent.compromised=true</script>')},
 redirect:{status:303,headers:{location:'https://next.example/receipt'},bytes:new Uint8Array()},
 blank:{status:200,headers:{contentType:'text/html',bindleTarget:'_blank'},bytes:encode('<h1>Isolated separate result</h1><form method="post" action="https://bindle-client.example/again"><button>Must stay disabled</button></form><img src="https://tracker.example/newtab">')}
};
test.before(async()=>{
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));origin='http://localhost:'+port;
 directory=await mkdtemp(join(tmpdir(),'bindle-browser-submissions-'));
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),kid='fixture-'+crypto.randomUUID();
 app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BRAND_NAME:'3sln.me',SIGNUP_ENABLED:'true',SIGNUP_CONTACT_REQUIRED:'true',FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify([{id:appOrigin+'/client',origin:appOrigin,name:'Submission fixture app',redirectUris:[appOrigin+'/callback']}]),FEDERATION_SCHEMAS:JSON.stringify({[fragment]:JSON.parse(await readFile('docs/artefacts/app-message-preferences-v1.json','utf8'))}),FORM_POSTBACK_ORIGINS:JSON.stringify([appOrigin]),APP_NOTIFICATION_SIGNING_JWK:JSON.stringify({...await crypto.subtle.exportKey('jwk',pair.privateKey),kid,alg:'ES256',use:'sig'}),APP_NOTIFICATION_PUBLIC_JWKS:JSON.stringify({keys:[{...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'ES256',use:'sig'}]})},mailer:{sendSetupCode:async value=>mail.push(value)},formTransport:{send:async request=>{sends.push(request);const mode=new URL(request.url).pathname.slice(1);if(mode==='unknown')throw Error('Controlled external outcome unknown');assert(modes[mode]);return modes[mode];}}});
 app.server.prependListener('request',request=>{if(request.method!=='POST')return;if(/^\/api\/messages\/[^/]+\/postbacks$/.test(request.url))dispatches.push({url:request.url,cookie:request.headers.cookie,authorization:request.headers.authorization,origin:request.headers.origin});if(request.url.endsWith('/postbacks/prepare'))preparations.push({cookie:request.headers.cookie,csrf:request.headers['x-csrf-token']});});
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));browser=await launch();
});
test.after(async()=>{await browser?.close();await app?.close();if(directory)await rm(directory,{recursive:true,force:true});});

async function activeOwner(context){
 const post=(path,data)=>context.request.post(origin+path,{headers:{Origin:origin},data});
 const config=await(await context.request.get(origin+'/api/config')).json();
 const created=await post('/api/auth/signup',{method:'password',password:'Independent browser primary password 2026!',termsAccepted:true,termsVersion:config.termsVersion,turnstileToken:'local-browser-test-token'});assert.equal(created.status(),200);const pending=await created.json();
 assert.equal((await post('/api/auth/setup/email/start',{pendingToken:pending.pendingToken,email:'reader@submissions.example'})).status(),200);assert.equal(mail.length,1);
 assert.equal((await post('/api/auth/setup/email/confirm',{pendingToken:pending.pendingToken,code:mail[0].code})).status(),200);
 const file=await(await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();const confirmed=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:file.recoveryToken,downloadConfirmed:true});assert.equal(confirmed.status(),200);const session=await confirmed.json();assert.equal(session.account.status,'active');return session;
}
async function connectApp(context,session){
 const page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(appOrigin+'/');await page.waitForFunction(()=>window.client);
 const login=await page.evaluate(({handle,host,fragment,contract})=>window.client.beginLogin(handle+'@'+host,{requests:[{fragment,required:true,purpose:'Send the forms explicitly reviewed in this test.',fields:['messages'],methods:{messages:{[contract]:['createOwn']}}}]}),{handle:session.account.handle,host:new URL(origin).host,fragment,contract});
 await page.goto(login.authorizationUrl);await page.getByRole('heading',{name:'Review application access'}).waitFor();await page.locator('summary').first().click();await page.locator('input[name="resource:messages"]').check();await page.getByRole('button',{name:'Save preferences and review'}).click();await page.getByRole('checkbox',{name:'Send app messages to your account'}).waitFor();await page.getByRole('button',{name:'Allow selected access'}).click();await page.waitForURL(appOrigin+'/callback');await page.waitForFunction(()=>window.result);
 await page.evaluate(async fragment=>{const login=await window.result;if(login.error)throw Error(login.error);window.reference=(await window.client.readPreferences(fragment)).values.messages;},fragment);return page;
}
async function shadowFrame(page,selector='.rich-message-frame'){
 const element=await page.locator(selector).elementHandle();assert(element);const frame=await element.contentFrame();assert(frame);await frame.waitForFunction(()=>window.auditShadow?.childElementCount>0);return frame;
}
async function closeMessage(page){
 if(!await page.locator('.message-detail').count())return;
 const element=await page.locator('.rich-message-frame').elementHandle(),frame=await element?.contentFrame();
 const detached=frame&&!frame.isDetached()?page.waitForEvent('framedetached',{predicate:value=>value===frame,timeout:10000}):Promise.resolve();
 await Promise.all([detached,page.locator('.message-detail .detail-toolbar').getByRole('button',{name:'Close',exact:true}).click()]);
 await page.locator('.rich-message-frame').waitFor({state:'detached'});
}
async function nativeShadowClick(page,frame,text,selector='.rich-message-frame'){
 await page.locator(selector).scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const position=await frame.evaluate(text=>{const button=[...window.auditShadow.querySelectorAll('button')].find(node=>node.textContent===text);if(!button)throw Error('Missing authored button');const box=button.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};},text),outer=await page.locator(selector).boundingBox();assert(outer);await page.mouse.click(outer.x+2+position.x,outer.y+2+position.y);
}

test('real Node browser submits signed app forms cookie-free and retains bounded status, HTML, redirect, unsupported-new-tab and unknown outcomes',async t=>{
 // This transport-focused test disables service workers so CDP observes each
 // real Node response directly; offline/SW behavior has separate browser tests.
 const context=await browser.newContext({serviceWorkers:'block',permissions:['local-network-access'],viewport:{width:1440,height:1000}});t.after(()=>context.close());const forbiddenRequests=[],errors=[];
 // Privileged test instrumentation observes closed roots; it does not change
 // their mode, author authority, CSP, sandbox flags, or trusted click handling.
 await context.addInitScript(()=>{addEventListener('message',event=>{if(event.data?.kind==='bindle-message-init')window.auditInit={sourceIsParent:event.source===parent,origin:event.origin};});const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);window.auditShadow=root;return root;};});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
  if(url.origin===appOrigin&&['/','/callback'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:`<!doctype html><h1>Submission fixture app</h1><script type="module">import {BindleClient} from ${JSON.stringify(origin+'/packages/sdk/src/identity.mjs')};window.client=new BindleClient({clientId:'${appOrigin}/client',redirectUri:'${appOrigin}/callback',allowInsecureLocalhost:true});if(location.pathname==='/callback')window.result=window.client.completeLogin().then(token=>({token}),error=>({error:error.message}));</script>`});
  forbiddenRequests.push(route.request().url());return route.abort();
 });
 // Observe a clone in the actual fetch realm before opaque child navigation
 // can invalidate CDP's response-body handle. The response and timing delivered
 // to the application remain unchanged; no request is repeated or synthesized.
 await context.addInitScript(()=>{
  window.auditPostbackResponses=[];const nativeFetch=window.fetch;
  window.fetch=async function(...args){const response=await nativeFetch.apply(this,args);
   if(/\/api\/messages\/[a-f0-9-]{36}\/postbacks$/.test(new URL(response.url).pathname)){
    void response.clone().json().then(result=>window.auditPostbackResponses.push({url:response.url,status:response.status,result}),error=>window.auditPostbackResponses.push({url:response.url,status:response.status,error:String(error)}));
   }
   return response;
  };
 });
 const session=await activeOwner(context),sender=await connectApp(context,session),messages=[];
 for(const mode of ['status','error','html','redirect','blank','unknown']){
  const body=`<h1>Original ${mode} form</h1><style>@import url(https://tracker.example/style);h1{color:inherit}</style><form method="post" action="${appOrigin}/${mode}"><input type="hidden" name="proof" value="app-scoped-proof"><input name="reply" value="Private answer ${mode}"><button>Send ${mode}</button></form><form method="post" target="_blank" action="${appOrigin}/must-not-submit"><button>Unavailable new tab</button></form><img src="https://tracker.example/pixel"><script>parent.compromised=true</script>`;
  const response=await sender.evaluate(async({subject,body})=>{try{return await window.client.userMessage(window.reference,{subject,mimeType:'text/html',body,tags:['browser-audit']});}catch(error){return {fixtureError:{code:error.code,status:error.status,message:error.message}};}},{subject:'Audit '+mode,body});assert.equal(response.fixtureError,undefined,JSON.stringify(response.fixtureError));assert.equal(response.result.accepted,true);messages.push({mode,body});
 }
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/console');await page.locator('.app-shell').waitFor();
 for(const {mode,body}of messages)await t.test(mode,async()=>{
  // These are independent deliveries; close and await the real old frame's
  // detachment before opening the next, retaining all within-message history checks.
  await closeMessage(page);
  await page.locator('.message-row').filter({hasText:'Audit '+mode}).click();await page.locator('.message-detail h2').filter({hasText:'Audit '+mode}).waitFor();const frame=await shadowFrame(page);
  await frame.waitForFunction(mode=>[...window.auditShadow.querySelectorAll('button')].some(button=>button.textContent==='Send '+mode),mode);
  assert.equal(await frame.evaluate(()=>[...window.auditShadow.querySelectorAll('button')].find(button=>button.textContent==='Unavailable new tab')?.disabled),true);assert.equal(await page.locator('.rich-message-frame').getAttribute('sandbox'),'allow-scripts');assert.equal(await page.evaluate(()=>window.compromised===true),false);
  const before=sends.length;await nativeShadowClick(page,frame,'Send '+mode);await page.getByRole('heading',{name:'Review message submission'}).waitFor();const dialog=page.getByRole('dialog');await dialog.getByText(appOrigin+'/'+mode,{exact:true}).waitFor();assert.equal(sends.length,before);if(mode==='status'){const geometry=await dialog.locator('.message-action-review').evaluate(node=>({overflows:node.scrollWidth>node.clientWidth+1,footnoteBottom:node.querySelector('.message-action-footnote').getBoundingClientRect().bottom,buttonsTop:node.querySelector('.message-action-buttons').getBoundingClientRect().top}));assert.equal(geometry.overflows,false,'Review destination and fields fit the trusted dialog');assert(geometry.footnoteBottom<=geometry.buttonsTop,'Footnote does not overlap submission controls');await screenshot(page,'message-submission-review');}
  const responseIndex=await page.evaluate(()=>window.auditPostbackResponses.length);const completed=page.waitForResponse(response=>response.url().endsWith('/postbacks')&&response.request().method()==='POST').then(response=>({status:response.status(),url:response.url()}));await dialog.getByRole('button',{name:'Send once',exact:true}).click();const response=await completed;assert.equal(response.status,200);await page.waitForFunction(index=>window.auditPostbackResponses.length>index,responseIndex);const observed=await page.evaluate(index=>window.auditPostbackResponses[index],responseIndex);assert.equal(observed.error,undefined);assert.equal(observed.url,response.url);assert.equal(observed.status,response.status);const result=observed.result;assert.equal(sends.length,before+1);
  const messageId=new URL(response.url).pathname.split('/')[3];const detail=await(await context.request.get(origin+'/api/messages/'+messageId)).json();assert.equal(detail.source.text,body);assert.equal(detail.message.appNotification.origin,appOrigin);
  assert.deepEqual(Object.keys(sends.at(-1).headers).sort(),['Content-Type','Idempotency-Key']);assert.equal(sends.at(-1).url,appOrigin+'/'+mode);assert.equal(new TextDecoder().decode(sends.at(-1).body),'proof=app-scoped-proof&reply=Private+answer+'+mode);
  assert(preparations.at(-1).cookie?.includes('bindle_session='));assert(preparations.at(-1).csrf);assert.equal(dispatches.at(-1).cookie,undefined);assert.equal(dispatches.at(-1).origin,origin);assert.match(dispatches.at(-1).authorization,/^Bearer /);
  await page.locator('.submission-toast').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.message-detail button')].some(button=>button.textContent==='Close'&&!button.disabled));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(mode==='status'){
   assert.equal(result.type,'status');await page.locator('.submission-toast').getByText('Saved <b>literally</b>',{exact:true}).waitFor();const links=page.locator('.submission-toast a');assert.equal(await links.count(),2);assert.equal(await links.first().locator('span').textContent(),'Help <img src=x>');assert.equal(await page.locator('.submission-toast img,b').count(),0);
   for(const link of await links.all()){assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);assert.match(await link.getAttribute('rel'),/noreferrer/);assert.equal(await link.getAttribute('referrerpolicy'),'no-referrer');assert(await link.locator('bdi').textContent());}
   await screenshot(page,'message-status-links');
  }else if(mode==='error'){assert.equal(result.toast.type,'error');await page.locator('.submission-error[role=alert]').getByText('Payment refused',{exact:true}).waitFor();}
  else if(mode==='html'){
   assert.equal(result.type,'message');assert.equal(detail.presentation.current.text,new TextDecoder().decode(modes.html.bytes));assert.equal(detail.presentation.history.length,1);const updated=await shadowFrame(page);await updated.waitForFunction(()=>window.auditShadow.textContent.includes('Retained local result'));await screenshot(page,'message-postback-history');
   await page.evaluate(()=>{window.auditPointers=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>window.auditPointers.push({type,text:event.target.textContent.slice(0,80),x:event.clientX,y:event.clientY}),true);});const loaded=page.waitForResponse(response=>response.url()===origin+'/api/messages/'+messageId+'?revision=0').then(response=>response.json());const history=page.getByRole('button',{name:'View original',exact:true});await history.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const handle=await history.elementHandle(),box=await history.boundingBox();assert(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();assert.equal(await handle.evaluate(button=>button.isConnected),true,'History button survives native mousedown');await page.mouse.up();assert.equal(await page.evaluate(()=>window.auditPointers.some(event=>event.type==='click'&&event.text==='View original')),true,'History uses a real pointer click');const selected=await loaded;assert.equal(selected.presentation.selected,null);assert.equal(selected.presentation.selectedRevision,0);const original=await shadowFrame(page);await original.waitForFunction(()=>window.auditShadow.textContent.includes('Original html form'));assert.equal(sends.length,before+1);
  }else if(mode==='redirect'){
   assert.equal(result.type,'redirect');assert.equal(detail.presentation.current,null);const link=page.getByRole('link',{name:/Open redirect in new tab/});assert.equal(await link.getAttribute('href'),'https://next.example/receipt');assert.match(await link.textContent(),/https:\/\/next\.example/);assert.equal(forbiddenRequests.some(url=>url.startsWith('https://next.example/')),false);
  }else if(mode==='blank'){
   assert.equal(result.type,'status');assert.equal(detail.presentation.current,null);assert.equal(await page.getByRole('button',{name:'View result in new tab',exact:true}).count(),0);assert.equal(context.pages().length,2);
  }else{
   assert.equal(result.type,'unknown');await page.locator('.submission-warning').getByText('Submission outcome is unknown. Do not submit again unless you have checked the result.',{exact:true}).waitFor();await nativeShadowClick(page,await shadowFrame(page),'Send unknown');await page.locator('.submission-warning').waitFor();assert.equal(await page.locator('.alerts .alert.success,.alerts .alert.error').count(),0,'Unknown outcome stays a warning without a conflicting global success or error');assert.equal(await page.getByRole('heading',{name:'Review message submission'}).count(),0);assert.equal(sends.length,before+1);
   const last=dispatches.at(-1),replay=await page.evaluate(async({path,authorization})=>{const response=await fetch(path,{method:'POST',credentials:'omit',headers:{Authorization:authorization,'Content-Type':'application/json'},body:'{}'});return {status:response.status,result:await response.json()};},{path:last.url,authorization:last.authorization});assert.equal(replay.status,200);assert.equal(replay.result.type,'unknown');assert.equal(sends.length,before+1);
   // Capture the visible OOPIF after its own paints: Chrome full-page capture
   // can reuse a stale narrow surface despite the live document's correct width.
   await page.locator('.rich-message-frame').scrollIntoViewIfNeeded();await(await shadowFrame(page)).evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:join(artifacts,'message-submission-unknown.png'),animations:'disabled'});
   await closeMessage(page);await page.reload();await page.locator('.app-shell').waitFor();assert.equal(sends.length,before+1);
  }
 });
 assert.deepEqual(forbiddenRequests,[]);assert.deepEqual(errors,[]);assert.equal(sends.length,6);
});

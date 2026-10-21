// Production shell and composition over explicit owner API fixtures. No demo endpoints.
import test from 'node:test';import assert from 'node:assert/strict';
import {launch,baseURL,waitForApp} from './browser.mjs';
let browser;test.before(async()=>{browser=await launch();});test.after(async()=>browser?.close());
for(const enabled of [false,true])for(const locale of ['en','es'])test(`Wave 5 shell ${locale}: integration flags ${enabled?'on':'off'}, navigation, adapters and access deep links`,async t=>{
 const context=await browser.newContext({viewport:{width:390,height:900}});t.after(()=>context.close());const page=await context.newPage(),errors=[],calls=[],account={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',handle:'wave5',status:'active',hasPassword:true};page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(locale=>localStorage.setItem('personal-space-preferences',JSON.stringify({locale})),locale);
 await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname;calls.push(path);let value;
  if(path==='/api/config')value={origin:baseURL,providers:{},localDevelopment:true,integrationsEnabled:enabled,eventBusesEnabled:false};
  else if(path==='/api/session')value={authenticated:true,account,sessionContext:'wave5',csrfToken:'csrf'};
  else if(path==='/api/account')value={account,collections:[],messages:[],contacts:[],rules:[],resources:[],grants:[],views:[]};
  else if(path==='/api/views')value={views:[]};else if(path==='/api/incoming')value={items:[],cursor:null,indexRevision:1};
  else if(path==='/api/connections/owner')value={connections:[{id:'integration-1',clientId:'https://notes.example/client',name:'Notes',state:'active',generation:1,integration:{kind:'external',snapshot:{manifest:{v:1,management_url:'https://notes.example/manage'}}}}],slots:[],offerings:[]};
  else if(path==='/api/grants')value={grants:[]};else if(path==='/api/preferences')value={preferences:[]};else if(path==='/api/apps')value={apps:[{id:'integration-1',clientId:'https://notes.example/client',name:'Notes',state:'active',generation:1}]};else if(path==='/api/connections/contracts')value={contracts:{}};
  else value={};await route.fulfill({json:value});
 });
 await waitForApp(page);await page.locator('.app-shell').waitFor();
 if(!enabled){assert.equal(await page.locator('.connections-console,.access-view').count(),0);assert.equal(calls.some(p=>p.startsWith('/api/connections')),false);return;}
 await page.locator('.nav-item').filter({hasText:/Apps.*integr/}).click();await page.locator('.connections-console [data-connection="integration-1"]').waitFor();assert.ok(calls.includes('/api/connections/owner'));
 await page.locator('.connections-console a[href*="#access/app/"]').click();try{await page.locator('.access-view').waitFor();}catch(error){console.error('Wave5 access diagnostic',page.url(),errors,calls,await page.locator('body').innerText());throw error;}assert.match(await page.locator('.access-view').textContent(),/notes\.example/);assert.ok(calls.includes('/api/grants'));assert.ok(calls.includes('/api/connections/contracts'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
});

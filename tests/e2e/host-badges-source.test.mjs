// Native browser SVG use/accessibility fixture; no build or external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {launch} from './browser.mjs';
import {compileBadgeSprite} from '../../packages/identity/badge-policy.mjs';
test('Chromium renders a compiled first-party symbol with literal accessible local badge metadata',async()=>{
 const origin='https://badges.example',root=resolve('.'),compiled=await compileBadgeSprite({}),spritePath='/api/badges/sprite.svg?v='+compiled.digest;
 const browser=await launch(),page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);requests.push(url.pathname+url.search);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="stylesheet" href="/apps/web/styles.css"><div id="app"></div><script type="module" src="/fixture.mjs"></script>'});
  if(url.pathname==='/fixture.mjs')return route.fulfill({contentType:'text/javascript',body:`import {dodo} from '/apps/web/src/shared/stack.mjs';import createApp from '/apps/web/src/ui/release-app.mjs';const view=createApp();dodo.reconcile(document.getElementById('app'),[view(${JSON.stringify({route:{kind:'home'},view:'security',session:{account:{handle:'n.1'}},config:{badgePolicy:{path:spritePath,definitions:compiled.definitions}},brand:{name:'Private Space',host:'badges.example'},data:{account:{id:'owner',handle:'n.1',badges:['system']}},busy:false,offline:false})})]);`});
  if(url.pathname==='/api/badges/sprite.svg'){assert.equal(url.searchParams.get('v'),compiled.digest);return route.fulfill({contentType:'image/svg+xml',headers:{'Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'},body:compiled.svg});}
  const file=resolve(root,url.pathname.slice(1));if(!file.startsWith(root+'/'))return route.abort();try{if(!(await stat(file)).isFile())return route.abort();return route.fulfill({contentType:['.mjs','.js'].includes(extname(file))?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream',body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
 });
 try{await page.goto(origin);const badge=page.locator('.local-account-badge');await badge.waitFor();await page.waitForFunction(()=>{const use=document.querySelector('.local-account-badge use');return use?.getBBox().width>0;});const nameBox=await badge.locator('span').boundingBox(),descriptionBox=await badge.locator('p').boundingBox();assert(descriptionBox.y>=nameBox.y+nameBox.height,'Badge description must not overlap its name');await mkdir('artifacts/browser',{recursive:true});await page.screenshot({path:'artifacts/browser/host-badges-console.png'});await badge.locator('svg').screenshot({path:'/tmp/bindle-host-badge.svg-render.png'});assert.equal(await badge.locator('svg').getAttribute('aria-label'),'System account');assert.equal(await badge.locator('use').getAttribute('href'),spritePath+'#system');assert.equal(await badge.locator('img,a,script,button').count(),0);assert.equal(requests.filter(path=>path===spritePath).length,1);assert.deepEqual(errors,[]);}finally{await browser.close();}
});

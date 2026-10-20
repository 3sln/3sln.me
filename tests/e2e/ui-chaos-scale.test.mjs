import test from 'node:test';
import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
import {chaosConsole,messages,builtinViews,seeded} from './chaos.mjs';

// UI scaling: what large accounts cost in the real renderer. Counts (DOM nodes,
// layouts, listeners, retained heap after a forced GC) are read through CDP;
// assertions use structural bounds, never wall-clock timings.
let browser;
test.before(async()=>{browser=await launch();});
test.after(async()=>{await browser?.close();});
async function metrics(context,page){const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');return {cdp,async read({gc=false}={}){if(gc){await cdp.send('HeapProfiler.collectGarbage');await cdp.send('HeapProfiler.collectGarbage');}const {metrics}=await cdp.send('Performance.getMetrics');return Object.fromEntries(metrics.map(({name,value})=>[name,value]));}};}
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);

test('a 5,000-message inbox renders one bounded page, grows by pages, and each page costs a bounded number of layouts',async t=>{
 const c=await chaosConsole(browser,t,{incoming:{all:messages(5000,{seed:5,tags:3})}});const {page,context}=c;
 const m=await metrics(context,page);await page.locator('.message-row').first().waitFor();await c.settled();
 assert.equal(await page.locator('.message-row').count(),50,'only the first server page is rendered');
 const perRow=(await m.read()).Nodes/50;assert.ok(perRow<400,`nodes per rendered row stay bounded (${perRow.toFixed(0)})`);
 // Cost of appending one page, measured per click: it must not grow with the rows already rendered.
 const costs=[];for(let pageIndex=2;pageIndex<=10;pageIndex++){const before=await m.read();await page.getByRole('button',{name:'Load more',exact:true}).click();await page.locator('.message-row').nth(pageIndex*50-1).waitFor();await c.settled();const after=await m.read();costs.push({layouts:after.LayoutCount-before.LayoutCount,styles:after.RecalcStyleCount-before.RecalcStyleCount});}
 assert.equal(await page.locator('.message-row').count(),500);
 const first=costs[0],last=costs.at(-1),median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 assert.ok(last.layouts<=first.layouts+3&&Math.max(...costs.map(cost=>cost.layouts))<=20,`layouts per page stay flat, not O(rows): ${JSON.stringify(costs.map(cost=>cost.layouts))}`);
 assert.ok(median(costs.slice(-3).map(cost=>cost.styles))<=median(costs.slice(0,3).map(cost=>cost.styles))*2+3&&Math.max(...costs.map(cost=>cost.styles))<=30,`style recalculations stay bounded against this run's first three pages: ${JSON.stringify(costs.map(cost=>cost.styles))}`);
 const retained=await m.read({gc:true});assert.ok(retained.Nodes/500<400,`nodes per rendered row remain bounded at scale (${(retained.Nodes/500).toFixed(0)})`);
 assert.equal(c.count('GET','/api/incoming'),10,'one request per page; no refetch loops');
});

test('long handles, names, subjects and tags never overflow the viewport at 390px or 320px',async t=>{
 const long=(prefix,length)=>(prefix+'-'.repeat(1)+'x'.repeat(length)).slice(0,length),handle=long('n.long',32);
 const items=messages(20,{seed:9,tags:6,tagLength:64}).map((item,index)=>({...item,subject:long('Subject'+index,200)}));
 const contacts=[{id:'55555555-1111-4111-8111-111111111111',name:long('Contact',120),active:true,form:'link',maxMessages:5,messagesUsed:0,expiresAt:Date.now()+86400000,intake:{autoTags:[long('auto',64)],optionalTags:[long('optional',64),long('second',64)]}}];
 const views=[...builtinViews(),{id:'long',name:long('View',100),revision:1,filter:{version:1},sort:'activity-desc'}];
 const c=await chaosConsole(browser,t,{account:{id:'11111111-2222-4333-8444-555555555555',handle,status:'active'},views,incoming:{all:items},data:{contacts}});const {page}=c;
 for(const width of [390,320]){await page.setViewportSize({width,height:900});
  for(const name of ['Messages','Contact links']){await page.evaluate(view=>document.getElementById('app').dispatchEvent(new CustomEvent('3sln-intent',{bubbles:true,detail:{kind:'navigate',view}})),name==='Messages'?'inbox':'contacts');await c.settled();assert.ok(await overflow(page)<=0,`${name} fits ${width}px (overflow ${await overflow(page)}px)`);}
 }
});

test('twenty signed-in accounts and many tags render completely, scroll vertically and keep controls usable',async t=>{
 const accounts=Array.from({length:20},(_,index)=>({account:{id:`${String(index).padStart(8,'0')}-2222-4333-8444-555555555555`,handle:'n.member'+String(index).padStart(2,'0')+'x'.repeat(20)},sessionContext:'ctx'+index,expiresAt:Date.now()+3600000}));
 const c=await chaosConsole(browser,t,{account:{id:accounts[0].account.id,handle:accounts[0].account.handle,status:'active'},viewport:{width:390,height:844},incoming:{all:messages(50,{seed:4,tags:32,tagLength:24})},handlers:{'GET /api/auth/accounts':route=>route.fulfill({json:{accounts,revision:'r'.repeat(43),activeOwner:accounts[0].account.id,pickerToken:'proof',limit:8,cleanupPending:false}})}});const {page}=c;
 assert.ok(await overflow(page)<=0,'32 tags per message wrap inside 390px');
 await page.getByRole('button',{name:'Switch account',exact:true}).click();await page.locator('.account-row').nth(19).waitFor();await c.settled();
 assert.equal(await page.locator('.account-row').count(),20);assert.ok(await overflow(page)<=0,'account list fits 390px');
 assert.equal(await page.getByRole('button',{name:'Add account',exact:true}).isDisabled(),true,'adding is disabled at the browser limit');
 await page.locator('.account-row').nth(19).scrollIntoViewIfNeeded();assert.ok(await page.locator('.account-row').nth(19).getByRole('button',{name:'Open account',exact:true}).isVisible());
});

test('repeated navigation, dialogs and message opens do not grow retained DOM, listeners or heap',async t=>{
 const items=messages(50,{seed:8,tags:4});
 const c=await chaosConsole(browser,t,{incoming:{all:items},handlers:{'GET ^/api/messages/[^/]+$':(route,{url})=>route.fulfill({json:{message:{...items.find(item=>url.pathname.endsWith(item.id)),text:'Body'},render:{kind:'text'}}}),'PATCH ^/api/messages/[^/]+$':route=>route.fulfill({json:{ok:true}})}});const {page,context}=c;
 const m=await metrics(context,page),random=seeded(0x3e3);
 const navigate=view=>page.evaluate(view=>document.getElementById('app').dispatchEvent(new CustomEvent('3sln-intent',{bubbles:true,detail:{kind:'navigate',view}})),view);
 const round=async()=>{for(const view of random.shuffle(['contacts','rules','resources','notifications','settings','security']))await navigate(view);await navigate('inbox');await page.locator('.message-row').first().waitFor();
  await page.getByRole('button',{name:'New View',exact:true}).first().click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('.message-row').nth(Math.floor(random.next()*items.length)).click();await page.getByText('Body',{exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();await c.settled();};
 for(let i=0;i<5;i++)await round();const baseline=await m.read({gc:true});
 for(let i=0;i<25;i++)await round();const after=await m.read({gc:true});
 assert.ok(after.Nodes<=baseline.Nodes*1.1+100,`retained DOM nodes stable (${baseline.Nodes} → ${after.Nodes})`);
 assert.ok(after.JSEventListeners<=baseline.JSEventListeners*1.1+25,`listeners stable (${baseline.JSEventListeners} → ${after.JSEventListeners})`);
 assert.ok(after.JSHeapUsedSize<=baseline.JSHeapUsedSize*1.3+2e6,`heap stable (${(baseline.JSHeapUsedSize/1e6).toFixed(1)} MB → ${(after.JSHeapUsedSize/1e6).toFixed(1)} MB)`);
 assert.ok(after.Documents<=baseline.Documents+1,`message frames are released (${baseline.Documents} → ${after.Documents} documents)`);
});

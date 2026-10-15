// Throwaway spike: does window.opener survive COOP combinations for an
// iframe-opened popup? Run: node tests/spikes/coop-opener/run.mjs
// Sites are fake https origins served by Playwright route interception, so
// app.example / provider.example / other.example are genuinely cross-site.
import { chromium, firefox, webkit } from 'playwright';

const APP = 'https://app.example', PROV = 'https://provider.example', OTHER = 'https://other.example';
const COOP = { none: null, so: 'same-origin', soap: 'same-origin-allow-popups' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page_ = (body, coop) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...(COOP[coop] ? { 'cross-origin-opener-policy': COOP[coop] } : {}) },
  body: `<!doctype html><meta charset=utf-8><body>${body}`,
});

function handle(url) {
  const u = new URL(url), q = u.searchParams, p = u.pathname;
  if (u.origin === APP || u.origin === OTHER) {
    if (p === '/app') {
      const fq = new URLSearchParams({ pc: q.get('pc') || 'none', name: q.get('name') || '', mode: q.get('mode') || '', replace: q.get('replace') || '' });
      const sb = q.get('sandbox');
      return page_(`<iframe id=f ${sb !== null ? `sandbox="${sb}"` : ''} src="${PROV}/frame?${fq}" width=400 height=200></iframe>
<button id=own>own</button><button id=guess>guess</button>
<script>
window.msgs=[];addEventListener('message',e=>msgs.push({origin:e.origin,data:e.data}));
own.onclick=()=>{const w=window.open('${PROV}/popup?coop=${q.get('pc') || 'none'}&role=app','_blank');window.ownNull=w===null};
guess.onclick=()=>{const names=['','popup','provider','_blank','${q.get('name') || 'zz'}'];window.guessLog=names.map(n=>{try{const w=window.open('',n);let href='n/a';try{href=w.location.href}catch(e){href=e.name}return {n,got:!!w,href}}catch(e){return {n,err:e.name}}})};
</script>`, q.get('coop') || 'none');
    }
    return { status: 404, headers: {}, body: '' };
  }
  if (u.origin !== PROV) return { status: 404, headers: {}, body: '' };
  if (p === '/frame') {
    const popupUrl = `${PROV}/popup?coop=${q.get('pc')}&role=frame${q.get('replace') ? '&replace=1' : ''}`;
    return page_(`<button id=go>go</button><script>
window.msgs=[];addEventListener('message',e=>msgs.push({origin:e.origin,data:e.data}));
window.info={origin:self.origin,domainProbe:(()=>{try{document.domain=document.domain;return 'ok'}catch(e){return e.name}})()};
go.onclick=()=>{let w;try{w=window.open(${JSON.stringify(popupUrl)},${JSON.stringify(q.get('name') || '_blank')})}catch(e){window.openErr=e.name}window.handle=w;window.openNull=w==null};
</script>`, 'none');
  }
  if (p === '/popup') {
    const role = q.get('role');
    return page_(`<script>
function run(stage){
  const r={stage,done:true,hasOpener:!!window.opener,origin:self.origin,name:window.name,
    domainProbe:(()=>{try{document.domain=document.domain;return 'ok'}catch(e){return e.name}})()};
  try{window.opener&&window.opener.postMessage({t:'exact',stage,role:${JSON.stringify(role)}},${JSON.stringify(PROV)})}catch(e){r.exactErr=e.name}
  try{window.opener&&window.opener.postMessage({t:'wild',stage,role:${JSON.stringify(role)}},'*')}catch(e){r.wildErr=e.name}
  window.__res=r;
}
run(1);
${q.get('replace') ? `setTimeout(()=>location.replace('${PROV}/popup2?coop=so&role=${role}'),300)` : ''}
</script>`, q.get('coop'));
  }
  if (p === '/popup2') {
    return page_(`<script>
const r={stage:2,done:true,hasOpener:!!window.opener,origin:self.origin};
try{window.opener&&window.opener.postMessage({t:'exact',stage:2},${JSON.stringify(PROV)})}catch(e){}
try{window.opener&&window.opener.postMessage({t:'wild',stage:2},'*')}catch(e){}
window.__res=r;</script>`, q.get('coop'));
  }
  if (p === '/store') {
    return page_(`<script>
window.got=[];const bc=new BroadcastChannel('ch');bc.onmessage=e=>got.push(e.data);window.bc=bc;
window.ls=(()=>{try{const prev=localStorage.getItem('k');localStorage.setItem('k',${JSON.stringify(q.get('id'))});return {prev}}catch(e){return {err:e.name}}})();
window.id=${JSON.stringify(q.get('id'))};
</script>`, 'none');
  }
  return { status: 404, headers: {}, body: '' };
}

async function mkContext(browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  ctx.setDefaultTimeout(8000);
  await ctx.route(/^https:\/\/(app|provider|other)\.example\//, (route) => {
    const r = handle(route.request().url());
    route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  return ctx;
}

async function popupRes(popup, stage = 1) {
  if (!popup) return null;
  try {
    await popup.waitForFunction((s) => window.__res && window.__res.stage === s, stage, { timeout: 3000 });
    return await popup.evaluate(() => window.__res);
  } catch (e) { return { noScript: true }; }
}

async function frameOpen(ctx, appUrl, { stage = 1 } = {}) {
  if (process.env.SPIKE_DEBUG) console.error('frameOpen', appUrl);
  const page = await ctx.newPage();
  await page.goto(appUrl);
  const frame = page.frames().find((f) => f.url().startsWith(PROV + '/frame'));
  const pw = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await frame.locator('#go').click();
  const popup = await pw;
  const res = await popupRes(popup, stage);
  await sleep(500);
  const fs = await frame.evaluate(() => ({ msgs: window.msgs, openNull: window.openNull, openErr: window.openErr, info: window.info })).catch((e) => ({ err: String(e) }));
  const as = await page.evaluate(() => window.msgs);
  return { page, frame, popup, res, fs, appMsgs: as };
}

const exactIn = (msgs, stage) => (msgs || []).some((m) => m.data.t === 'exact' && (stage ? m.data.stage === stage : true));
const wildIn = (msgs, stage) => (msgs || []).some((m) => m.data.t === 'wild' && (stage ? m.data.stage === stage : true));

async function closeAll(ctx) { for (const p of ctx.pages()) await p.close().catch(() => {}); }

async function runEngine(name, type, launchOpts = {}, label = name) {
  const browser = await type.launch(launchOpts);
  // Probe: some environments launch WebKit but never return from newPage().
  const probe = await Promise.race([browser.newPage().then((pg) => pg.close().then(() => 'ok')), sleep(20000).then(() => 'hang')]);
  if (probe !== 'ok') { browser.close().catch(() => {}); return { name: label, version: browser.version(), error: 'newPage() did not return within 20s in this environment; engine not testable here' }; }
  const out = { name: label, version: browser.version(), t1: {}, own: {}, t3: {}, t4: {}, t5: {}, t6: {} };
  const ctx = await mkContext(browser);

  // 1 & 2: appCoop x popupCoop, iframe-opened
  for (const ac of ['none', 'so', 'soap']) for (const pc of ['none', 'so', 'soap']) {
    const r = await frameOpen(ctx, `${APP}/app?coop=${ac}&pc=${pc}`);
    out.t1[`${ac}/${pc}`] = {
      popupOpened: !!r.popup, windowOpenNull: r.fs.openNull, opener: r.res?.hasOpener,
      exactToFrame: exactIn(r.fs.msgs), wildToFrame: wildIn(r.fs.msgs),
      appGotAny: r.appMsgs.length,
    };
    await closeAll(ctx);
  }
  // app-opened control (popup COOP none, and so)
  for (const ac of ['none', 'so', 'soap']) for (const pc of ['none', 'so']) {
    const page = await ctx.newPage();
    await page.goto(`${APP}/app?coop=${ac}&pc=${pc}`);
    const pw = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await page.click('#own');
    const popup = await pw; const res = await popupRes(popup); await sleep(500);
    const am = await page.evaluate(() => window.msgs);
    out.own[`${ac}/${pc}`] = { opener: res?.hasOpener, exactToApp: exactIn(am), wildToApp: wildIn(am) };
    await closeAll(ctx);
  }
  // 3: replace to COOP same-origin
  for (const ac of ['none', 'soap']) {
    const r = await frameOpen(ctx, `${APP}/app?coop=${ac}&pc=none&replace=1`);
    const r1 = r.res;
    let r2 = null;
    if (r.popup) { r2 = await popupRes(r.popup, 2); if (process.env.SPIKE_DEBUG) console.error('t3', ac, r.popup.url(), JSON.stringify(r2)); }
    await sleep(500);
    const fm = await r.frame.evaluate(() => window.msgs);
    out.t3[ac] = { stage1Opener: r1?.hasOpener, stage1ExactToFrame: exactIn(fm, 1), stage2Opener: r2?.hasOpener, stage2ExactToFrame: exactIn(fm, 2), stage2WildToFrame: wildIn(fm, 2) };
    await closeAll(ctx);
  }
  // 4: app reference to the iframe-opened popup
  for (const nm of ['', 'pn']) {
    const r = await frameOpen(ctx, `${APP}/app?coop=none&pc=none&name=${nm}`);
    const before = ctx.pages().length;
    await r.page.click('#guess'); await sleep(700);
    const after = ctx.pages().length;
    const g = await r.page.evaluate(() => ({ guess: window.guessLog, winLen: window.length, frame1: (() => { try { return typeof window.frames[1]; } catch (e) { return e.name; } })() }));
    out.t4[nm || 'unnamed'] = { newPagesCreatedByGuessing: after - before, guessCount: g.guess.length, hrefs: g.guess.map((x) => x.n + ':' + x.href).join(' '), winLen: g.winLen, frames1: g.frame1 };
    await closeAll(ctx);
  }
  // 5: sandbox
  for (const sb of ['allow-scripts allow-same-origin', 'allow-scripts allow-same-origin allow-popups', 'allow-scripts allow-popups', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox']) {
    const r = await frameOpen(ctx, `${APP}/app?coop=none&pc=none&sandbox=${encodeURIComponent(sb)}`);
    out.t5[sb] = {
      frameOrigin: r.fs.info?.origin, frameDomainProbe: r.fs.info?.domainProbe,
      windowOpenNull: r.fs.openNull, openErr: r.fs.openErr, popupOpened: !!r.popup,
      popupOrigin: r.res?.origin, popupDomainProbe: r.res?.domainProbe, popupScript: r.res ? !r.res.noScript : null,
      popupOpener: r.res?.hasOpener, exactToFrame: exactIn(r.fs.msgs), wildToFrame: wildIn(r.fs.msgs),
    };
    await closeAll(ctx);
  }
  // 6: BroadcastChannel / localStorage partitioning
  {
    const t1 = await ctx.newPage(); await t1.goto(`${PROV}/store?id=T1`);
    const t2 = await ctx.newPage(); await t2.goto(`${PROV}/store?id=T2`);
    const f1p = await ctx.newPage(); await f1p.goto(`${APP}/app?coop=none&pc=none&mode=store`);
    const f2p = await ctx.newPage(); await f2p.goto(`${OTHER}/app?coop=none&pc=none&mode=store`);
    // swap iframe src to the store page (same provider origin) inside each top-level site
    for (const [p, id] of [[f1p, 'F1'], [f2p, 'F2']]) {
      await p.evaluate((u) => { document.getElementById('f').src = u; }, `${PROV}/store?id=${id}`);
      await p.waitForFunction(() => true);
    }
    await sleep(800);
    const fr = (p) => p.frames().find((f) => f.url().startsWith(PROV + '/store'));
    const F1 = fr(f1p), F2 = fr(f2p);
    const who = { T1: t1, T2: t2, F1, F2 };
    const read = async () => Object.fromEntries(await Promise.all(Object.entries(who).map(async ([k, c]) => [k, await c.evaluate(() => ({ got: window.got.map((g) => g.from), ls: window.ls }))])));
    const post = async (k) => { await who[k].evaluate((id) => window.bc.postMessage({ from: id }), k); await sleep(500); };
    const result = { receivedBy: {} };
    for (const k of ['T1', 'F1']) { await post(k); }
    const s = await read();
    result.receivedBy = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.got.join(',') || '-']));
    result.localStorageSeenOnLoad = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, JSON.stringify(v.ls)]));
    out.t6 = result;
    await closeAll(ctx);
  }
  await browser.close();
  return out;
}

// Playwright's Chromium launches with --disable-features=...ThirdPartyStoragePartitioning, which would
// invalidate test 6, so Chromium also runs once with that feature force-enabled.
const df = await disabledFeaturesArg();
const engines = [['chromium', chromium, {}, 'chromium (playwright defaults)'], ['chromium', chromium, { args: ['--enable-features=ThirdPartyStoragePartitioning', `--disable-features=${df.split(',').filter((x) => x !== 'ThirdPartyStoragePartitioning').join(',')}`], ignoreDefaultArgs: [`--disable-features=${df}`] }, 'chromium (partitioning enabled)'], ['firefox', firefox, {}, 'firefox (playwright defaults)'], ['firefox', firefox, { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5 } }, 'firefox (cookieBehavior=5, state partitioning)'], ['webkit', webkit]];
async function disabledFeaturesArg() {
  const b = await chromium.launch({ args: ['--enable-automation'] }); const c = await b.newBrowserCDPSession();
  const { arguments: a } = await c.send('Browser.getBrowserCommandLine'); await b.close();
  return a.find((x) => x.startsWith('--disable-features=')).slice('--disable-features='.length);
}
const only = process.argv[2];
const all = [];
for (const [n, t, lo, lbl] of engines) {
  if (only && !lbl?.startsWith(only) && only !== n) continue;
  try { all.push(await runEngine(n, t, lo, lbl)); } catch (e) { all.push({ name: n, error: String(e.stack || e) }); }
}
console.log(JSON.stringify(all, null, 1));

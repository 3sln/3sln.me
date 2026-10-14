import test from 'node:test';
import assert from 'node:assert/strict';
import { argon2id } from 'hash-wasm';
import { encryptRecoveryFile } from '../../packages/recovery/index.mjs';
import { launch, baseURL } from './browser.mjs';

test('independent browser audit: untrusted metadata stays inert and wrong answer/provider never transmits recovery authority', async () => {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
  const answer = 'private audit phrase 8fe137';
  const payload = { version: 1, issuer: 'https://other-provider.example', handle: 'alice', recoveryToken: '11111111-1111-1111-1111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', warning: 'Non-live audit fixture' };
  const prompt = '<img src="/audit-leak" onerror="window.auditInjected=true">';
  const hint = 'https://untrusted.example/answer-here';
  const file = await encryptRecoveryFile(payload, [{ id: 'phrase', type: 'passphrase', prompt, hint }], [answer], { deriveKey: argon2id });
  const browser = await launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    page.on('request', request => requests.push({ url: request.url(), body: request.postData() }));
    await page.addInitScript(() => {
      window.auditIntents = [];
      document.addEventListener('3sln-intent', event => window.auditIntents.push(JSON.stringify(event.detail)), true);
    });
    const response = await page.goto(`${baseURL}/recovery/restore`);
    assert.ok(response.headers()['content-security-policy'].includes("frame-src 'none'"));
    await page.locator('input[type=file]').setInputFiles({ name: 'audit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.getByRole('button', { name: 'Read recovery questions', exact: true }).click();
    await page.locator('input[name="unlock:phrase"]').waitFor();
    assert.ok((await page.locator('.unlock-question').innerText()).includes(prompt));
    assert.ok((await page.locator('.unlock-question').innerText()).includes(hint));
    assert.equal(await page.locator('.unlock-question img,.unlock-question a,.unlock-question script').count(), 0);
    await page.locator('input[name="unlock:phrase"]').fill('wrong private audit phrase');
    await page.getByRole('button', { name: 'Unlock recovery file', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'could not be decrypted' }).waitFor();
    assert.equal(await page.locator('input[name="unlock:phrase"]').inputValue(), '');
    await page.locator('input[name="unlock:phrase"]').fill(answer);
    await page.getByRole('button', { name: 'Unlock recovery file', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'another service' }).waitFor();
    const visibleState = await page.evaluate(() => ({ intents: window.auditIntents, local: { ...localStorage }, session: { ...sessionStorage }, injected: window.auditInjected === true, scripts: [...document.scripts].map(script => script.src) }));
    assert.equal(visibleState.injected, false);
    assert.equal(visibleState.scripts.some(url => url.includes('challenges.cloudflare.com')), false);
    assert.equal(JSON.stringify(visibleState).includes(answer), false);
    assert.equal(JSON.stringify(visibleState).includes(payload.recoveryToken), false);
    assert.equal(requests.some(request => request.url.includes('/api/auth/recover')), false);
    assert.equal(requests.some(request => request.url.includes('/audit-leak') || request.url.includes('untrusted.example')), false);
    assert.equal(JSON.stringify(requests).includes(answer), false);
    assert.equal(JSON.stringify(requests).includes(payload.recoveryToken), false);
  } finally { await browser.close(); }
});

test('independent browser audit: repeated submit starts one worker and navigation terminates it', async () => {
  const file = await encryptRecoveryFile({ version: 1, issuer: baseURL, handle: 'alice', recoveryToken: '11111111-1111-1111-1111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', warning: 'Non-live audit fixture' }, [{ id: 'phrase', type: 'passphrase', prompt: 'Private phrase' }], ['private cancellation fixture'], { deriveKey: argon2id });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const events = [];
    const recoverRequests = [];
    page.on('console', message => { if (message.text().startsWith('audit-worker:')) events.push(message.text()); });
    page.on('request', request => { if (request.url().includes('/api/auth/recover')) recoverRequests.push(request.url()); });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          console.debug('audit-worker:created');
          // Cancel at the actual worker boundary while its real computation is
          // starting. The application still owns lifecycle/termination.
          if (window.auditCancelOnWorker) queueMicrotask(() => document.querySelector('.pause-setup').click());
        }
        terminate() {
          // Console events emitted during unload can be dropped by DevTools.
          // This test-only counter contains no application data and survives
          // same-tab navigation so termination is independently observable.
          sessionStorage.setItem('audit-worker-terminated', String(Number(sessionStorage.getItem('audit-worker-terminated') || 0) + 1));
          return super.terminate();
        }
      };
    });
    await page.goto(`${baseURL}/recovery/restore`);
    await page.locator('input[type=file]').setInputFiles({ name: 'audit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.getByRole('button', { name: 'Read recovery questions', exact: true }).click();
    await page.locator('input[name="unlock:phrase"]').fill('private cancellation fixture');
    await page.evaluate(() => {
      window.auditCancelOnWorker = true;
      const form = document.querySelector('input[name="unlock:phrase"]').form;
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.waitForURL(`${baseURL}/console?signin`);
    await page.locator('.auth-card').waitFor();
    assert.equal(events.filter(event => event === 'audit-worker:created').length, 1);
    assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('audit-worker-terminated') || 0)), 1);
    assert.equal(recoverRequests.length, 0);
  } finally { await browser.close(); }
});

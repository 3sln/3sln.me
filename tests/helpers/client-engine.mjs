// Client engine harness (docs/architecture/app-engine.md §10). Load under the
// browser loader (tests/browser/loader.mjs): the web app imports ngin as /vendor/.
//
// A real ngin Engine with the real BrowserStateProvider and fake `api` and
// `browser` providers. Tests dispatch the production bl/* Actions and observe the
// resulting browser model, engine facts and API calls, without rendering. Fakes
// are scripted per route; a route handler may return a pending promise, which is
// how a test holds a request open while another dispatch overtakes it.
//
//   const c = await createClientEngine({ state: { session }, routes: { 'GET /api/auth/accounts': () => inventory } });
//   await c.dispatch(new OpenAccounts());
//   c.snapshot().browserAccounts; c.api.calls; c.facts; await c.dispose();
import { Engine, Provider } from '../../vendor/ngin/index.js';
import BrowserStateProvider from '../../apps/web/src/providers/browser-state.mjs';

/** The `api` provider resource: request context like createAPI, responses from `routes`. */
export function fakeApi(routes = {}) {
  const calls = [];
  return {
    csrf: null, account: null, sessionContext: null, contextGeneration: 0, calls, routes,
    captureContext() { return { owner: this.account, sessionContext: this.sessionContext, csrfToken: this.csrf }; },
    setContext(result) { this.contextGeneration++; this.account = result?.account?.id ?? null; this.sessionContext = result?.sessionContext ?? null; this.csrf = result?.csrfToken ?? null; },
    clearContext() { this.contextGeneration++; this.account = null; this.sessionContext = null; this.csrf = null; },
    get(path, options) { return this.request(path, undefined, 'GET', options); },
    async request(path, body, method = 'POST', options = {}) {
      const call = { method, path, body: body === undefined ? undefined : structuredClone(body), context: options.context === undefined ? this.captureContext() : options.context };
      calls.push(call);
      const handler = routes[`${method} ${path}`];
      if (!handler) throw Object.assign(new Error(`No fake route for ${method} ${path}`), { code: 'not_found', status: 404 });
      return structuredClone(await handler(call));
    },
  };
}
/** The `browser` provider resource: in-memory secrets and counters for every side effect bl/accounts uses. */
export function fakeBrowser(overrides = {}) {
  const secrets = {}, effects = [];
  const note = name => (...args) => { effects.push([name, ...args]); };
  return {
    secrets, effects,
    secret: key => secrets[key], storeSecret: (key, value) => { secrets[key] = value; },
    consumeSubmission: () => undefined, clearOwnerContext: note('clearOwnerContext'), cancelDeviceEntry: note('cancelDeviceEntry'),
    setCaptchaAction: note('setCaptchaAction'), installCaptcha: note('installCaptcha'), announceAccounts: note('announceAccounts'), focusAccounts: note('focusAccounts'),
    pushSubscriptionId: async () => null, unsubscribePush: note('unsubscribePush'),
    ...overrides,
  };
}

export async function createClientEngine({ state = {}, routes = {}, api = fakeApi(routes), browser = fakeBrowser(), providers = {} } = {}) {
  const engine = new Engine({ providers: { state: BrowserStateProvider, api: Provider.fromSingleton(api), browser: Provider.fromSingleton(browser), ...providers } });
  await engine.container.use({ state: { write: true } }, ({ state: model }) => model.transition(next => Object.assign(next, { loading: false }, state)));
  const facts = [], record = event => facts.push(event.type);
  for (const type of ['browser-state-updated', 'contact-handoff-ready', 'account-updated']) engine.feed.addEventListener(type, record);
  return {
    engine, api, browser, facts,
    /** Dispatch and wait for the terminal event; rejects only if the Action itself threw. */
    dispatch: action => engine.dispatch(action).next('complete'),
    /** The current browser model through a read lease (frozen; the UI projection reads the same state). */
    snapshot: () => engine.container.use(['state'], ({ state: model }) => model.snapshot()),
    async dispose() { await engine.dispose(); },
  };
}
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const turn = () => new Promise(resolve => setTimeout(resolve, 0));

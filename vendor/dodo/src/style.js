/**
 * Optional shadow DOM scoping for dodo.
 *
 *   - **`css`** — a tagged template producing a constructable stylesheet.
 *   - **`scoped(props?, ...children)`** — renders children into a shadow root,
 *     with those stylesheets adopted.
 *
 * Style scoping is the one thing here the platform does properly and no
 * userland convention can match: rules inside a shadow root cannot leak out,
 * and page rules cannot leak in.
 */

import {settings as resolveSettings} from './settings.js';
import {requireConstructor} from './dom.js';

const sheetCache = new WeakMap();

function buildSheet(cssText, view) {
  const CSSStyleSheetCtor = requireConstructor(view, 'CSSStyleSheet');
  const sheet = new CSSStyleSheetCtor();
  sheet.replaceSync(cssText);
  return sheet;
}

function sameValues(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * A constructable stylesheet from a tagged template.
 *
 *     const styles = css`p { color: ${color}; }`;
 *
 * Memoised per call site. A tagged template hands the same frozen `strings`
 * array to every evaluation of that literal, so the cache can be keyed on it:
 * a `css` inside a render function returns the identical sheet each render
 * unless an interpolated value actually changed. Without that, every render
 * would build a new sheet and reassigning `adoptedStyleSheets` would force a
 * style recalculation each time.
 *
 * Pass `{window}` via `css.in(view)` to build in another realm.
 */
export function css(strings, ...values) {
  return buildFromTemplate(globalThis, strings, values);
}

/** `css` bound to a particular realm, for iframes and non-global test DOMs. */
css.in =
  view =>
  (strings, ...values) =>
    buildFromTemplate(view, strings, values);

function buildFromTemplate(view, strings, values) {
  const cached = sheetCache.get(strings);
  if (cached && cached.view === view && sameValues(cached.values, values)) {
    return cached.sheet;
  }

  let cssText = '';
  for (let i = 0; i < strings.length; i++) {
    cssText += strings[i];
    // Note the explicit nullish check: `${0}` is a legitimate value, and a
    // truthiness test would silently drop it.
    if (i < values.length) cssText += values[i] ?? '';
  }

  const sheet = buildSheet(cssText, view);
  sheetCache.set(strings, {view, values, sheet});
  return sheet;
}

const SHADOW_ROOT_KEY = Symbol('dodo.style.shadowRoot');
const ADOPTED_KEY = Symbol('dodo.style.adopted');

export default function styleFactory(userSettings) {
  const settings = resolveSettings(userSettings);
  const {dodo} = settings;
  const {special, reconcile} = dodo;
  const isMap = settings.isMap ?? (x => x?.constructor === Object);
  const rawMapGet = settings.mapGet ?? ((m, k) => m[k]);
  const mapGet = (map, key) => (map == null ? undefined : rawMapGet(map, key));

  /**
   * Reconciles `children` into `host`'s shadow root, creating it if needed, and
   * adopts `styleSheets`.
   *
   * Exported for imperative use — mounting a dodo tree into a shadow root you
   * own, rather than one `scoped` created.
   */
  function reconcileShadow(host, children, styleSheets = []) {
    let shadowRoot = host[SHADOW_ROOT_KEY];
    if (!shadowRoot) {
      shadowRoot = host.shadowRoot ?? host.attachShadow({mode: 'open'});
      host[SHADOW_ROOT_KEY] = shadowRoot;
    }

    // Reassigning forces a style recalculation, so only do it when the list
    // actually changed. Assigning an empty list matters as much as a full one:
    // bones only ever assigned a non-empty list, so removing the last
    // stylesheet left it adopted for good.
    const adopted = host[ADOPTED_KEY];
    if (!adopted || !sameValues(adopted, styleSheets)) {
      host[ADOPTED_KEY] = styleSheets;
      shadowRoot.adoptedStyleSheets = styleSheets;
    }

    reconcile(shadowRoot, children);
    return shadowRoot;
  }

  function detachShadow(host) {
    const shadowRoot = host[SHADOW_ROOT_KEY];
    delete host[SHADOW_ROOT_KEY];
    delete host[ADOPTED_KEY];
    if (!shadowRoot) return;
    // A shadow root cannot be removed once attached, so its contents are torn
    // down instead. Bones skipped this, so nothing inside a `scoped` subtree
    // ever saw its `$detach` hook and its listeners stayed attached.
    reconcile(shadowRoot, null);
    shadowRoot.adoptedStyleSheets = [];
  }

  /**
   * `scoped(props?, ...children)` — renders children into a shadow root.
   *
   * | prop          | meaning                                     |
   * | ------------- | ------------------------------------------- |
   * | `styleSheets` | constructable stylesheets to adopt           |
   */
  const scoped = special({
    update(host, args) {
      const hasProps = isMap(args[0]);
      const props = hasProps ? args[0] : null;
      const children = hasProps ? args.slice(1) : args;
      reconcileShadow(host, children, mapGet(props, 'styleSheets') ?? []);
    },

    detach(host) {
      detachShadow(host);
    },
  });

  return {scoped, reconcileShadow, detachShadow};
}

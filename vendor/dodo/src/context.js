/**
 * Optional DOM-scoped context for dodo.
 *
 * A provider stashes a map of data on its own DOM node; a consumer walks up the
 * DOM to collect every provider above it, merges them (nearest wins) and
 * subscribes for changes. Nothing is registered globally, so two independent
 * widgets on the same page never see each other's context.
 *
 * Consumers expose the merged context as a Cell, so the actual rendering is
 * just `watch` from the reactive module.
 *
 * Shadow DOM is a real boundary here:
 *   - `withContext` provides data that *does* cross shadow roots.
 *   - `withEncapsulatedContext` provides data that stops at the shadow root it
 *     lives in, so a component's internal context stays internal.
 */

// Only the `notifier` helper is imported: the reactive API this module renders
// through is injected, not reached for.
import {notifier} from './reactive.js';
import {settings as resolveSettings} from './settings.js';

const OPEN_KEY = Symbol('dodo.context.open');
const ENCAPSULATED_KEY = Symbol('dodo.context.encapsulated');
const CONSUMER_STATE = Symbol('dodo.context.consumer');

class ContextProvider {
  constructor(data) {
    this.data = data;
    const {listeners, notify} = notifier();
    this.listeners = listeners;
    this.notify = notify;
  }

  update(data) {
    this.data = data;
    this.notify();
  }

  onDirty(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy() {
    // Consumers below are torn down by their own detach; dropping the listeners
    // here just makes a late notification impossible.
    this.listeners.clear();
  }
}

/**
 * Walks from `startNode` to the top of the tree, collecting providers.
 *
 * Encapsulated providers drop out of the walk once it crosses a shadow root;
 * open ones do not. The result is returned outermost first, which is the order
 * to merge in: later entries win, so the nearest provider takes precedence.
 */
function collectProviders(startNode) {
  const chain = [];
  let current = startNode;
  let crossedShadowBoundary = false;

  while (current) {
    if (!crossedShadowBoundary && current[ENCAPSULATED_KEY]) {
      chain.push(current[ENCAPSULATED_KEY]);
    }
    if (current[OPEN_KEY]) chain.push(current[OPEN_KEY]);

    const parent = current.parentElement;
    if (parent) {
      current = parent;
      continue;
    }
    const host = current.getRootNode?.()?.host;
    if (!host) break;
    crossedShadowBoundary = true;
    current = host;
  }

  chain.reverse();
  return chain;
}

function sameProviders(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Builds the context components.
 *
 *     const {withContext, useContext} = context({dodo, reactive: reactive({dodo})});
 *
 * Consumers render through a `watch`, so the reactive API is a required
 * injected dependency. Building one here instead would produce a `watch` that
 * is a different component from the application's — a `special`'s identity is
 * its descriptor object, and the reconciler uses that identity for node reuse —
 * so the dependency is stated rather than quietly satisfied.
 *
 * Takes the same settings as `reactive`, plus `reactive` itself.
 */
export default function contextFactory(userSettings) {
  const settings = resolveSettings(userSettings);
  const {dodo, reactive} = settings;
  const {special, reconcile} = dodo;

  if (typeof reactive?.watch !== 'function') {
    throw new Error(
      'context() requires a reactive API providing a watch component, ' +
        'e.g. context({dodo, reactive: reactive({dodo})})',
    );
  }
  const {watch} = reactive;
  const mapGet = settings.mapGet ?? ((m, k) => m[k]);
  const mapMerge = settings.mapMerge ?? ((...maps) => Object.assign({}, ...maps));
  const newMap = settings.newMap ?? (obj => ({...obj}));
  const mapPut =
    settings.mapPut ??
    ((m, k, v) => {
      m[k] = v;
      return m;
    });
  const shouldUpdate = settings.shouldUpdate ?? ((a, b) => a !== b);

  function selectKeys(data, keys) {
    let selected = newMap({});
    for (const key of keys) {
      selected = mapPut(selected, key, data == null ? undefined : mapGet(data, key));
    }
    return selected;
  }

  /**
   * A Cell over the context visible from `element`, narrowed to `keys`.
   *
   * The provider chain is re-resolved on every read and on every `refresh()`,
   * so moving the element in the DOM or mounting a new provider above it is
   * picked up rather than baked in at construction time.
   */
  function contextCell(element, keys) {
    const {listeners, notify} = notifier();
    let providers = [];
    let unsubscribes = [];
    const api = {
      keys,
      refresh() {
        const next = collectProviders(element);
        if (sameProviders(next, providers)) return;
        providers = next;
        if (listeners.size > 0) {
          for (const unsubscribe of unsubscribes) unsubscribe();
          unsubscribes = providers.map(provider => provider.onDirty(notify));
        }
      },
      onDirty(fn) {
        listeners.add(fn);
        if (listeners.size === 1) {
          providers = collectProviders(element);
          unsubscribes = providers.map(provider => provider.onDirty(notify));
        }
        let removed = false;
        return () => {
          if (removed) return;
          removed = true;
          listeners.delete(fn);
          if (listeners.size === 0) {
            for (const unsubscribe of unsubscribes) unsubscribe();
            unsubscribes = [];
          }
        };
      },
      getValue() {
        const chain = collectProviders(element);
        const merged = chain.length === 0 ? newMap({}) : mapMerge(...chain.map(p => p.data));
        return selectKeys(merged, api.keys);
      },
    };
    return api;
  }

  /** Reads the context visible from `element` once, without subscribing. */
  function readContext(element, keys) {
    const chain = collectProviders(element);
    const merged = chain.length === 0 ? newMap({}) : mapMerge(...chain.map(p => p.data));
    return selectKeys(merged, keys);
  }

  function providerKey(encapsulated) {
    return encapsulated ? ENCAPSULATED_KEY : OPEN_KEY;
  }

  /** Imperatively makes `domNode` a context provider. */
  function attachContext(domNode, contextData, encapsulated = false) {
    const key = providerKey(encapsulated);
    if (!domNode[key]) {
      domNode[key] = new ContextProvider(contextData);
    }
    return domNode[key];
  }

  /** Replaces the data of a provider previously attached to `domNode`. */
  function updateContext(domNode, newContextData, encapsulated = false) {
    const provider = domNode[providerKey(encapsulated)];
    if (provider) provider.update(newContextData);
  }

  /** Removes a provider from `domNode`. */
  function detachContext(domNode, encapsulated = false) {
    const key = providerKey(encapsulated);
    const provider = domNode[key];
    if (provider) {
      provider.destroy();
      delete domNode[key];
    }
  }

  function providerComponent(encapsulated) {
    return special({
      update(domNode, args, oldArgs) {
        const data = args[0];
        if (!oldArgs) {
          attachContext(domNode, data, encapsulated);
        } else if (shouldUpdate(oldArgs[0], data)) {
          updateContext(domNode, data, encapsulated);
        }
        // Children are reconciled after the provider is in place so that
        // consumers created on this pass already see it.
        reconcile(domNode, args.slice(1));
      },
      detach(domNode) {
        detachContext(domNode, encapsulated);
        reconcile(domNode, null);
      },
    });
  }

  /** `withContext(data, ...children)` — provides data across shadow roots. */
  const withContext = providerComponent(false);

  /** `withEncapsulatedContext(data, ...children)` — stops at the shadow root. */
  const withEncapsulatedContext = providerComponent(true);

  /**
   * `useContext(keys, builder)` — renders `builder(selected)` with the named
   * keys of the surrounding context, re-rendering when any of them changes.
   *
   * Only the selected keys matter: a provider updating a key this consumer did
   * not ask for invalidates the cell but produces an equal selection, and the
   * re-render is skipped.
   */
  const useContext = special({
    attach(element) {
      element[CONSUMER_STATE] = {cell: null};
    },

    update(element, [keys, builder]) {
      const state = element[CONSUMER_STATE];
      if (!state) return;
      if (!state.cell) {
        state.cell = contextCell(element, keys);
      } else {
        state.cell.keys = keys;
        state.cell.refresh();
      }
      // The cell keeps its identity across updates so `watch` does not tear
      // down and rebuild its subscription on every parent render.
      reconcile(element, [watch(state.cell, builder)]);
    },

    detach(element) {
      delete element[CONSUMER_STATE];
      reconcile(element, null);
    },
  });

  return {
    withContext,
    withEncapsulatedContext,
    useContext,
    contextCell,
    readContext,
    attachContext,
    updateContext,
    detachContext,
  };
}

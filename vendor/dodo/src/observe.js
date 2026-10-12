/**
 * Optional element observation for dodo.
 *
 * Two layers:
 *
 *   - **Cells.** `elementSize`, `elementVisibility` and `elementIntersection`
 *     are plain functions of an element. They have no dependency on dodo at all
 *     and can be read, tested and composed on their own.
 *   - **Components.** `withElementSize` and `withVisibility` render a builder
 *     against one of those cells, and are thin wrappers over `watch`.
 *
 * Cleanup is structural. Each cell connects its observer on its first listener
 * and disconnects on its last, so a detached `watch` takes the observer with
 * it — there is no teardown to forget.
 *
 * Observer constructors and `getComputedStyle` are taken from the element's own
 * realm rather than from globals, so an element inside an iframe is observed by
 * that iframe's implementation, and a test environment whose DOM is not
 * installed globally still works. Pass `{window}` to override.
 */

// Only pure helpers are imported: the reactive API these components render
// through is injected, not reached for.
import {PENDING, connectable} from './reactive.js';
import {settings as resolveSettings} from './settings.js';
import {requireConstructor, windowFor} from './dom.js';

/**
 * Walks up to the first ancestor that actually generates a box.
 *
 * Dodo gives every `alias` and `special` wrapper `display: contents`, and both
 * `ResizeObserver` and `IntersectionObserver` report nothing useful for such an
 * element. Crosses shadow boundaries, since a host is the laid out thing when
 * its shadow content is not.
 */
export function nearestLaidOutElement(element, {window: override} = {}) {
  let current = element;
  while (current) {
    const view = windowFor(current, override);
    // An element outside a document has no computed display at all; treat that
    // as "not laid out" and keep walking rather than settling for a wrapper.
    const display = view.getComputedStyle?.(current)?.display;
    if (display && display !== 'contents') return current;

    const parent = current.parentElement;
    if (parent) {
      current = parent;
      continue;
    }
    const host = current.getRootNode?.()?.host;
    if (!host) break;
    current = host;
  }
  return element;
}

function sizeOf(entry, box) {
  if (box === 'border-box' && entry.borderBoxSize?.length) {
    const {inlineSize, blockSize} = entry.borderBoxSize[0];
    return {width: inlineSize, height: blockSize};
  }
  if (box === 'device-pixel-content-box' && entry.devicePixelContentBoxSize?.length) {
    const {inlineSize, blockSize} = entry.devicePixelContentBoxSize[0];
    return {width: inlineSize, height: blockSize};
  }
  if (entry.contentBoxSize?.length) {
    const {inlineSize, blockSize} = entry.contentBoxSize[0];
    return {width: inlineSize, height: blockSize};
  }
  const {width, height} = entry.contentRect;
  return {width, height};
}

function measure(element) {
  const rect = element.getBoundingClientRect();
  return {width: rect.width, height: rect.height};
}

/**
 * A Cell over an element's size, as a plain `{width, height}`.
 *
 * Plain on purpose: a `DOMRectReadOnly` defeats dodo's change detection, which
 * treats any object that is neither an array nor a plain object as always
 * changed — every observer callback would re-render. A plain object is shallow
 * compared, so a resize that does not change the box renders nothing.
 *
 * Never `PENDING`: with no observation to hand it measures directly, so there
 * is no "not known yet" state for callers to handle.
 *
 * | option   | meaning                                                     |
 * | -------- | ----------------------------------------------------------- |
 * | `box`    | `content-box` (default), `border-box`, `device-pixel-content-box` |
 * | `window` | override the realm the observer is taken from                |
 */
export function elementSize(element, options = {}) {
  const {box = 'content-box', window: override} = options;
  let target = null;
  let latest = null;

  const resolve = () => nearestLaidOutElement(element, {window: override});

  return connectable(
    notify => {
      target = resolve();
      const view = windowFor(target, override);
      const ResizeObserverCtor = requireConstructor(view, 'ResizeObserver');
      const observer = new ResizeObserverCtor(entries => {
        latest = sizeOf(entries[entries.length - 1], box);
        notify();
      });
      observer.observe(target, {box});
      return () => {
        observer.disconnect();
        target = null;
        latest = null;
      };
    },
    () => latest ?? measure(target ?? resolve()),
  );
}

function intersectionCell(element, options, select) {
  const {root, rootMargin, threshold, initial = PENDING, window: override} = options;
  let latest = initial;

  return connectable(
    notify => {
      const view = windowFor(element, override);
      const IntersectionObserverCtor = requireConstructor(view, 'IntersectionObserver');
      // A string root is resolved against the element's own ancestry, so a
      // component can name its scroll container without being handed one.
      const rootElement = typeof root === 'string' ? element.closest(root) : (root ?? null);
      const observer = new IntersectionObserverCtor(
        entries => {
          latest = select(entries[entries.length - 1]);
          notify();
        },
        {root: rootElement, rootMargin, threshold},
      );
      observer.observe(element);
      return () => {
        observer.disconnect();
        latest = initial;
      };
    },
    () => latest,
  );
}

/**
 * A Cell over whether an element intersects its root.
 *
 * `PENDING` until the observer delivers its first entry — that arrives
 * asynchronously and there is no synchronous way to know beforehand. Reporting
 * `false` would be a guess, and a wrong one shows the wrong branch for a frame;
 * pair it with `watch`'s `placeholder`, or pass `{initial: false}` to accept the
 * guess.
 *
 * | option       | meaning                                                   |
 * | ------------ | --------------------------------------------------------- |
 * | `root`       | a selector resolved with `closest`, an element, or null    |
 * | `rootMargin` | passed through to `IntersectionObserver`                   |
 * | `threshold`  | passed through to `IntersectionObserver`                   |
 * | `initial`    | value before the first entry, `PENDING` by default         |
 * | `window`     | override the realm the observer is taken from              |
 */
export function elementVisibility(element, options = {}) {
  return intersectionCell(element, options, entry => entry.isIntersecting);
}

/** As `elementVisibility`, but reporting `{visible, ratio}`. */
export function elementIntersection(element, options = {}) {
  return intersectionCell(element, options, entry => ({
    visible: entry.isIntersecting,
    ratio: entry.intersectionRatio,
  }));
}

const SIZE_STATE = Symbol('dodo.observe.size');
const VISIBILITY_STATE = Symbol('dodo.observe.visibility');

/**
 * Builds the observation components.
 *
 *     const {withElementSize, withVisibility} = observe({dodo, reactive});
 *
 * Takes the same settings as `reactive`, plus a required `reactive` API — these
 * render through its `watch`, and building a private one would produce a
 * component the application's reconciler treats as unrelated.
 */
export default function observeFactory(userSettings) {
  const settings = resolveSettings(userSettings);
  const {dodo, reactive} = settings;
  const {special, reconcile} = dodo;

  if (typeof reactive?.watch !== 'function') {
    throw new Error(
      'observe() requires a reactive API providing a watch component, ' +
        'e.g. observe({dodo, reactive: reactive({dodo})})',
    );
  }
  const {watch} = reactive;
  const shouldUpdate = settings.shouldUpdate ?? ((a, b) => a !== b);

  // The cell is rebuilt only when the options actually change, so an inline
  // options literal does not tear down and re-create the observer every render.
  function cellFor(element, state, options, build) {
    if (!state.cell || shouldUpdate(state.options, options)) {
      state.options = options;
      state.cell = build(element, options ?? {});
    }
    return state.cell;
  }

  /**
   * `withElementSize(builder, options?)` — renders `builder({width, height})`
   * with the size of the nearest laid out ancestor, which for a component
   * nested in `display: contents` wrappers is its real container.
   */
  const withElementSize = special({
    attach(element) {
      element[SIZE_STATE] = {cell: null, options: undefined};
    },

    update(element, [builder, options]) {
      const state = element[SIZE_STATE];
      if (!state) return;
      const cell = cellFor(element, state, options, elementSize);
      // `options` carries `error` through to `watch`. A size is never PENDING,
      // so `placeholder` has nothing to do here.
      reconcile(element, [watch(cell, builder, options)]);
    },

    detach(element) {
      // Detaching the watch below unsubscribes from the cell, which disconnects
      // the observer; there is nothing else to release.
      delete element[SIZE_STATE];
      reconcile(element, null);
    },
  });

  /**
   * `withVisibility(builder, options?)` — renders `builder(isVisible)`.
   *
   * Unlike `withElementSize` this observes the component's *own* node, since
   * the point is usually whether this particular content is on screen. That
   * needs a box, so the node is given `display: block` — pass a different
   * `display`, or `null` to observe the nearest laid out ancestor instead.
   */
  const withVisibility = special({
    attach(element) {
      element[VISIBILITY_STATE] = {cell: null, options: undefined, display: undefined};
    },

    update(element, [builder, options]) {
      const state = element[VISIBILITY_STATE];
      if (!state) return;

      const display = options?.display === undefined ? 'block' : options.display;
      if (state.display !== display) {
        state.display = display;
        if (display) element.style.display = display;
      }

      const build = (el, opts) =>
        elementVisibility(display ? el : nearestLaidOutElement(el, opts), opts);

      reconcile(element, [watch(cellFor(element, state, options, build), builder, options)]);
    },

    detach(element) {
      delete element[VISIBILITY_STATE];
      reconcile(element, null);
    },
  });

  return {withElementSize, withVisibility};
}

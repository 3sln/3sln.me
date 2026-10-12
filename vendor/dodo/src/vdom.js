const ELEMENT_NODE = Symbol('ELEMENT_NODE');
const ALIAS_NODE = Symbol('ALIAS_NODE');
const SPECIAL_NODE = Symbol('SPECIAL_NODE');
const OPAQUE_NODE = Symbol('OPAQUE_NODE');
const NODE_STATE = Symbol('NODE_STATE');
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// Property names that must never be written through to a DOM node: assigning
// `__proto__` swaps the node's prototype, which corrupts the element for every
// later operation. Relevant whenever props are built from untrusted data.
const UNSAFE_PROP_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// HTML tag names come back from the DOM upper cased while SVG/MathML keep their
// authored case. A plain case-insensitive compare covers both, and unlike
// `localeCompare` it neither builds a collator nor depends on the host locale.
function sameTagName(nodeName, tag) {
  return typeof tag === 'string' && nodeName.toLowerCase() === tag.toLowerCase();
}

// Whether an object can describe itself as text. `Object.prototype.toString`
// answers "[object Object]" for anything that has not said otherwise, and a
// null-prototyped object cannot answer at all.
function hasTextForm(value) {
  return (
    typeof value[Symbol.toPrimitive] === 'function' ||
    (typeof value.toString === 'function' && value.toString !== Object.prototype.toString)
  );
}

// Props, styling, classes, attributes and dataset belong to an element, not to
// an alias's or a special's argument list.
function assertElementNode(vnode, method) {
  if (vnode.type !== ELEMENT_NODE && vnode.type !== OPAQUE_NODE) {
    throw new Error(`${method} can only be used on element nodes (h).`);
  }
}

// Styling, classes, attributes and dataset all live in one `$` object rather
// than in a field of their own each. It keeps "did any of these change" to a
// single identity check for the common node that chains none of them, and the
// object is only allocated for a node that chains at least one.
function setSpecial(vnode, method, name, value) {
  assertElementNode(vnode, method);
  // All four keys are written up front so that every `$` object shares a shape.
  if (!vnode.$) {
    vnode.$ = {styling: undefined, classes: undefined, attrs: undefined, dataset: undefined};
  }
  vnode.$[name] = value;
  return vnode;
}

class VNode {
  constructor(type, tag, args) {
    this.type = type;
    this.tag = tag;
    this.args = args;
    // Declared up front so that every vnode shares one shape regardless of
    // which setters are chained onto it, or in what order. Writing a field that
    // already exists is not a shape transition; adding one is.
    this.p = undefined;
    this.k = undefined;
    this.hooks = undefined;
    this.$ = undefined;
  }

  // Every setter replaces rather than merges: calling one twice leaves only the
  // second value.
  props(props) {
    assertElementNode(this, '.props()');
    this.p = props;
    return this;
  }

  key(k) {
    this.k = k;
    return this;
  }

  on(hooks) {
    this.hooks = hooks;
    return this;
  }

  style(styling) {
    return setSpecial(this, '.style()', 'styling', styling);
  }

  classes(...classes) {
    return setSpecial(this, '.classes()', 'classes', classes);
  }

  attrs(attrs) {
    return setSpecial(this, '.attrs()', 'attrs', attrs);
  }

  data(dataset) {
    return setSpecial(this, '.data()', 'dataset', dataset);
  }

  opaque() {
    if (this.type !== ELEMENT_NODE) {
      throw new Error('.opaque() can only be used on element nodes (h).');
    }
    this.type = OPAQUE_NODE;
    return this;
  }
}

// How large a nested array or object may be before `sameNested` gives up and
// says "changed". Values built inline in a render function are small — a props
// bag, a pair, a short list — and the bound is what keeps the extra comparison
// from turning into an unbounded walk over whatever a caller happens to pass.
const NESTED_COMPARE_LIMIT = 8;

// One level below the top, and no further.
//
// Everything a render function builds inline is a fresh object, so comparing
// the members of an args array or a props map by identity means an `alias`
// called as `component({a, b})` never once matches its previous arguments, and
// a `.props({style: {...}})` never matches either. Both are the documented way
// to write them, and both quietly cost a full re-render every time.
//
// Only plain objects and arrays are opened up. Anything else keeps its old
// answer of "changed", because for most other objects the interesting state is
// not in the own enumerable keys at all: a `DOMRect` has none, so descending
// into one by prototype would report every rect as equal to every other and a
// `watch` over an element's size would stop updating.
function sameNested(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.constructor !== b.constructor) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length || a.length > NESTED_COMPARE_LIMIT) return false;
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== b[j]) return false;
    }
    return true;
  }

  if (a.constructor === Object) {
    const keysA = Object.keys(a);
    if (keysA.length > NESTED_COMPARE_LIMIT || keysA.length !== Object.keys(b).length) return false;
    for (const key of keysA) {
      if (!hasOwn(b, key) || a[key] !== b[key]) return false;
    }
    return true;
  }

  return false;
}

function defaultShouldUpdate(a, b) {
  if (a === b) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.constructor !== b.constructor) return true;

    // `!==` first at both levels, so two identical members cost a comparison
    // and not a call. Only members that actually differ are looked into.
    if (Array.isArray(a)) {
      if (a.length !== b.length) return true;
      for (let j = 0; j < a.length; j++) {
        if (a[j] !== b[j] && !sameNested(a[j], b[j])) return true;
      }
      return false;
    }

    if (a.constructor === Object) {
      const keysA = Object.keys(a);
      if (keysA.length !== Object.keys(b).length) return true;
      for (const key of keysA) {
        if (!hasOwn(b, key)) return true;
        if (a[key] !== b[key] && !sameNested(a[key], b[key])) return true;
      }
      return false;
    }
  }
  return true;
}

function isIterable(x) {
  return (
    Array.isArray(x) ||
    (x != null && typeof x[Symbol.iterator] === 'function' && typeof x !== 'string')
  );
}

function alias(f) {
  return (...args) => new VNode(ALIAS_NODE, f, args);
}

function special(o) {
  return (...args) => new VNode(SPECIAL_NODE, o, args);
}

function newElementNamespace(parentNode, newNodeTag) {
  if (parentNode.namespaceURI === HTML_NAMESPACE) {
    switch (newNodeTag) {
      case 'svg':
        return 'http://www.w3.org/2000/svg';
      case 'math':
        return 'http://www.w3.org/1998/Math/MathML';
    }
  }
  return parentNode.namespaceURI ?? parentNode.host?.namespaceURI ?? HTML_NAMESPACE;
}

// `originalProps` is null-prototyped so that prop names like `__proto__` or
// `toString` are recorded as ordinary own keys rather than hitting Object.prototype.
function newNodeState(vdom) {
  return {originalProps: Object.create(null), newVdom: vdom};
}

function createElementNode(parentNode, tag, vdom) {
  const el = parentNode.ownerDocument.createElementNS(newElementNamespace(parentNode, tag), tag);
  el[NODE_STATE] = newNodeState(vdom);
  return el;
}

const documentToFocusWithinSet = new WeakMap();

function getPathFromElement(element) {
  const path = [];
  let current = element;
  while (current) {
    path.push(current);
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      current = current.getRootNode()?.host;
    }
  }
  return path;
}

function addPathToFocusWithinSet(set, path) {
  for (const node of path) {
    set.add(node);
  }
}

// The realm's own `Node.prototype` is what we want, so that a node from an
// iframe or a detached document is moved by its own implementation. Falls back
// through the configured window and then the ambient one, either of which may
// be all that is available for a document with no `defaultView`.
function nodePrototypeFor(doc, settingsWindow) {
  const view = settingsWindow ?? doc?.defaultView ?? globalThis;
  return view.Node?.prototype ?? view.Element?.prototype;
}

// `moveBefore` relocates without detaching, so it keeps focus and does not
// restart animations; it only applies to a node that is already in the document.
function placeNode(target, node, before, insertBefore, moveBefore) {
  const op = moveBefore && node.isConnected ? moveBefore : insertBefore;
  op.call(target, node, before);
}

// `moveBefore` is a `ParentNode` method, so it is on `Element` and
// `DocumentFragment` and never on `Node` — looking for it beside `insertBefore`
// finds nothing in every browser that implements it. Which prototype depends on
// what is being reconciled into: an element, or a shadow root or fragment.
function parentMoveBeforeFor(target, doc, settingsWindow) {
  const view = settingsWindow ?? doc?.defaultView ?? globalThis;
  const proto =
    target.nodeType === 1 /* ELEMENT_NODE */
      ? view.Element?.prototype
      : view.DocumentFragment?.prototype;
  return typeof proto?.moveBefore === 'function' ? proto.moveBefore : null;
}

function installFocusTrackingForDocument(doc) {
  const focusWithinSet = new Set();
  // The set is rebuilt on every focusin rather than accumulated. `focusin`
  // fires after `focusout`, and its composed path is the path of the element
  // that just gained focus, so this is always exactly the current focus path.
  // Accumulating instead would leave every previously focused element marked as
  // holding focus for the rest of the document's life.
  doc.addEventListener('focusin', event => {
    focusWithinSet.clear();
    addPathToFocusWithinSet(focusWithinSet, event.composedPath());
  });
  doc.addEventListener('focusout', event => {
    // A focusout with no relatedTarget means focus left the document entirely;
    // otherwise the focusin that follows will rebuild the set.
    if (!event.relatedTarget) focusWithinSet.clear();
  });
  addPathToFocusWithinSet(focusWithinSet, getPathFromElement(doc.activeElement));
  documentToFocusWithinSet.set(doc, focusWithinSet);
  return focusWithinSet;
}

export default userSettings => {
  const shouldUpdate = userSettings?.shouldUpdate ?? defaultShouldUpdate;
  const isMap = userSettings?.isMap ?? (x => x?.constructor === Object);
  const mapIter = userSettings?.mapIter ?? (m => Object.entries(m));
  const mapGet = userSettings?.mapGet ?? ((m, k) => m[k]);
  const mapMerge = userSettings?.mapMerge ?? ((...maps) => Object.assign({}, ...maps));
  const newMap = userSettings?.newMap ?? (obj => ({...obj}));
  const mapPut =
    userSettings?.mapPut ??
    ((m, k, v) => {
      m[k] = v;
      return m;
    });
  const isSeq = userSettings?.isSeq ?? isIterable;
  const seqIter = userSettings?.seqIter ?? (s => s);
  const convertName = userSettings?.convertName ?? (x => x);
  const convertTagName = userSettings?.convertTagName ?? convertName;
  const convertPropName = userSettings?.convertPropName ?? convertName;
  const convertStyleName = userSettings?.convertStyleName ?? convertName;
  const convertDataName = userSettings?.convertDataName ?? convertName;
  const convertClassName = userSettings?.convertClassName ?? convertName;
  const convertHookName = userSettings?.convertHookName ?? convertName;
  const listenerKey = userSettings?.listenerKey ?? 'listener';
  const captureKey = userSettings?.captureKey ?? 'capture';
  const passiveKey = userSettings?.passiveKey ?? 'passive';

  const EMPTY_MAP = newMap({});

  function toIterator(iterableOrIterator) {
    if (iterableOrIterator == null) return [][Symbol.iterator]();
    if (typeof iterableOrIterator[Symbol.iterator] === 'function') {
      return iterableOrIterator[Symbol.iterator]();
    }
    if (typeof iterableOrIterator.next === 'function') {
      return iterableOrIterator;
    }
    return [iterableOrIterator][Symbol.iterator]();
  }

  // Reconciling one element walks its props, styling, attrs, dataset and hooks,
  // so building an array of [name, value] pairs for each of those maps is the
  // single biggest source of garbage in an update. `mapEach` is the iteration
  // primitive the reconciler actually uses: it visits entries without
  // materialising them.
  //
  // Supply `mapEach` for a custom collection and it is as cheap as a plain
  // object — ClojureScript has `reduce-kv`, Immutable.js has `forEach`. Supply
  // only `mapIter` and it still works, by way of the pairs it yields; that is
  // the existing contract and it is unchanged.
  //
  // The extra `a`/`b`/`c` slots let call sites pass context to a hoisted
  // visitor, so iterating does not allocate a closure either.
  // `for...in` with an own-key guard, not `Object.keys`: it allocates no key
  // array and measures ~3.5x faster, while enumerating exactly the same keys.
  // The guard has to be the hoisted `hasOwnProperty.call` — `Object.hasOwn`
  // reads better but benchmarks about the same as building the key array,
  // which defeats the point.
  function defaultMapEach(map, visit, a, b, c) {
    if (map == null) return;
    for (const key in map) {
      if (hasOwn(map, key)) visit(key, map[key], a, b, c);
    }
  }

  function mapEachViaIter(map, visit, a, b, c) {
    if (map == null) return;
    const iterator = toIterator(mapIter(map));
    let result;
    while (!(result = iterator.next()).done) {
      const entry = result.value;
      visit(entry[0], entry[1], a, b, c);
    }
  }

  // Only fall back to the plain-object walk when the user has told us nothing
  // about their maps. Overriding `mapIter` alone still routes through it.
  const mapEach =
    userSettings?.mapEach ?? (userSettings?.mapIter ? mapEachViaIter : defaultMapEach);

  // `null`, `undefined` and `false` are the "render nothing" values. Note the
  // checks are strict: `0` and `''` are legitimate text children.
  function isBlank(item) {
    return item === null || item === undefined || item === false;
  }

  function flattenSeqIntoArray(array, items, excludeFalsey) {
    const iterator = toIterator(seqIter(items));
    let result;
    while (!(result = iterator.next()).done) {
      const item = result.value;
      if (excludeFalsey && isBlank(item)) {
        continue;
      }

      if (!isSeq(item)) {
        array.push(item);
      } else {
        flattenSeqIntoArray(array, item, excludeFalsey);
      }
    }
  }

  function defaultFlattenSeq(items, excludeFalsey) {
    const array = [];
    flattenSeqIntoArray(array, items, excludeFalsey);
    return array;
  }

  const flattenSeq = userSettings?.flattenSeq ?? defaultFlattenSeq;

  function flattenVNodeChildren(children) {
    const array = [];
    for (let i = 0; i < children.length; i++) {
      const item = children[i];
      if (isBlank(item)) continue;
      if (!isSeq(item)) {
        array.push(item);
      } else {
        flattenSeqIntoArray(array, item, true);
      }
    }
    return array;
  }

  // Blank children are filtered out before they reach here, but a custom
  // `flattenSeq` may not do that filtering, so never assume `.toString()` exists.
  function toText(value) {
    if (isBlank(value)) return '';
    // Vnodes and seqs are dealt with before anything reaches here, so an object
    // in the text position is a mistake — most often a map that belongs in
    // `.props()` or `.style()` and landed in the child list instead. Rendering
    // it would put the string "[object Object]" on the page, which is never
    // what was meant, so it is refused wherever it turns up rather than only in
    // the slot props used to occupy. An object that can describe itself as text
    // (a `Date`, a `URL`, anything with its own `toString`) still renders.
    if (typeof value === 'object' && !hasTextForm(value)) {
      throw new Error(
        'invalid child: an object with no text form. If it is a map of element properties, chain .props({...}) instead.',
      );
    }
    return String(value);
  }

  // Everything after the tag is a child. Properties are chained on with
  // `.props()`, which is also the only way to reach an element's property when
  // its name collides with one of the setters.
  function h(tag, ...children) {
    return new VNode(ELEMENT_NODE, convertTagName(tag), children);
  }

  // Visitors are hoisted to the factory closure rather than written inline, so
  // that iterating a map allocates neither entries nor a callback.
  function setStyleProperty(name, value, style) {
    style.setProperty(convertStyleName(name), value);
  }

  function removeStaleStyleProperty(name, _value, style, newStyling) {
    if (mapGet(newStyling, name) !== undefined) return;
    style.removeProperty(convertStyleName(name));
  }

  function reconcileElementStyling(target, oldStyling, newStyling) {
    const style = target.style;
    mapEach(newStyling, setStyleProperty, style);
    mapEach(oldStyling, removeStaleStyleProperty, style, newStyling);
  }

  function setAttribute(name, value, target) {
    target.setAttribute(convertPropName(name), value);
  }

  function removeStaleAttribute(name, _value, target, newAttrs) {
    if (mapGet(newAttrs, name) !== undefined) return;
    target.removeAttribute(convertPropName(name));
  }

  function reconcileElementAttributes(target, oldAttrs, newAttrs) {
    mapEach(newAttrs, setAttribute, target);
    mapEach(oldAttrs, removeStaleAttribute, target, newAttrs);
  }

  function setDataProperty(name, value, target) {
    target.dataset[convertDataName(name)] = value;
  }

  function removeStaleDataProperty(name, _value, target, newDataset) {
    if (mapGet(newDataset, name) !== undefined) return;
    delete target.dataset[convertDataName(name)];
  }

  function reconcileElementDataset(target, oldDataset, newDataset) {
    mapEach(newDataset, setDataProperty, target);
    mapEach(oldDataset, removeStaleDataProperty, target, newDataset);
  }

  function reconcileElementClasses(target, oldClasses, newClasses) {
    // Both sides are compared post-conversion, otherwise a non-identity
    // `convertClassName` would never match an old class against a new one.
    const classesToRemove = new Set();
    for (const c of flattenSeq(oldClasses, true)) {
      const className = convertClassName(c);
      if (className) classesToRemove.add(className);
    }
    for (const c of flattenSeq(newClasses, true)) {
      const className = convertClassName(c);
      // `classList.add('')` throws, and empty class names carry no meaning.
      if (!className) continue;
      classesToRemove.delete(className);
      target.classList.add(className);
    }
    for (const className of classesToRemove) {
      target.classList.remove(className);
    }
  }

  // The chained counterpart to the `$`-prefixed props: one pass over the four
  // facets a vnode can carry. Reconciling them from the vnode rather than from
  // the props map means a `.style()` map rebuilt with the same contents is
  // compared as a map, not by identity, so it does not force a second pass.
  function reconcileElementSpecials(target, newSpecials, oldSpecials) {
    if (!newSpecials && !oldSpecials) return;

    const newStyling = newSpecials?.styling;
    const oldStyling = oldSpecials?.styling;
    if (newStyling !== undefined || oldStyling !== undefined) {
      if (newStyling !== undefined && !isMap(newStyling)) {
        throw new Error('invalid value for .style(), expected a map');
      }
      reconcileElementStyling(target, oldStyling ?? EMPTY_MAP, newStyling ?? EMPTY_MAP);
    }

    // `.classes()` collects its rest arguments, so this side is always an array
    // — nested seqs within it are flattened by `reconcileElementClasses`.
    const newClasses = newSpecials?.classes;
    const oldClasses = oldSpecials?.classes;
    if (newClasses !== undefined || oldClasses !== undefined) {
      reconcileElementClasses(target, oldClasses ?? [], newClasses ?? []);
    }

    const newAttrs = newSpecials?.attrs;
    const oldAttrs = oldSpecials?.attrs;
    if (newAttrs !== undefined || oldAttrs !== undefined) {
      if (newAttrs !== undefined && !isMap(newAttrs)) {
        throw new Error('invalid value for .attrs(), expected a map');
      }
      reconcileElementAttributes(target, oldAttrs ?? EMPTY_MAP, newAttrs ?? EMPTY_MAP);
    }

    const newDataset = newSpecials?.dataset;
    const oldDataset = oldSpecials?.dataset;
    if (newDataset !== undefined || oldDataset !== undefined) {
      if (newDataset !== undefined && !isMap(newDataset)) {
        throw new Error('invalid value for .data(), expected a map');
      }
      reconcileElementDataset(target, oldDataset ?? EMPTY_MAP, newDataset ?? EMPTY_MAP);
    }
  }

  function setElementProp(target, nodeState, propName, newValue) {
    if (UNSAFE_PROP_NAMES.has(propName)) {
      console.error(`Refusing to assign unsafe prop name '${propName}' to a DOM node.`);
      return;
    }
    const originalProps = nodeState.originalProps;
    if (!(propName in originalProps)) {
      originalProps[propName] = target[propName];
    }
    target[propName] = newValue === undefined ? originalProps[propName] : newValue;
  }

  function restoreElementProp(target, nodeState, propName) {
    const originalProps = nodeState.originalProps;
    if (propName in originalProps) {
      target[propName] = originalProps[propName];
      delete originalProps[propName];
    }
  }

  function applyProp(name, newValue, target, oldProps, isHtml) {
    if (Object.is(newValue, mapGet(oldProps, name))) return;

    const propName = convertPropName(name);
    if (isHtml) {
      setElementProp(target, target[NODE_STATE], propName, newValue);
    } else if (newValue === undefined) {
      target.removeAttribute(propName);
    } else {
      target.setAttribute(propName, newValue);
    }
  }

  function restoreRemovedProp(name, _oldValue, target, props, isHtml) {
    if (mapGet(props, name) !== undefined) return; // it wasn't removed

    const propName = convertPropName(name);
    if (isHtml) {
      restoreElementProp(target, target[NODE_STATE], propName);
    } else {
      target.removeAttribute(propName);
    }
  }

  function reconcileElementProps(target, props) {
    const nodeState = target[NODE_STATE];
    const isHtml = target.namespaceURI === HTML_NAMESPACE;
    const oldProps = nodeState.vdom?.p ?? EMPTY_MAP;

    mapEach(props, applyProp, target, oldProps, isHtml);
    mapEach(oldProps, restoreRemovedProp, target, props, isHtml);
  }

  function addListener(target, hookName, listener) {
    if (typeof listener === 'function') {
      target.addEventListener(hookName, listener);
    } else if (listener != null) {
      target.addEventListener(hookName, mapGet(listener, listenerKey), {
        capture: !!mapGet(listener, captureKey),
        passive: !!mapGet(listener, passiveKey),
      });
    }
  }

  function removeListener(target, hookName, listener) {
    if (typeof listener === 'function') {
      target.removeEventListener(hookName, listener);
    } else if (listener != null) {
      target.removeEventListener(
        hookName,
        mapGet(listener, listenerKey),
        !!mapGet(listener, captureKey),
      );
    }
  }

  function addInitialListener(name, listener, target) {
    const hookName = convertHookName(name);
    if (hookName[0] === '$') return;
    addListener(target, hookName, listener);
  }

  function swapListener(name, listener, target, oldHooks) {
    const hookName = convertHookName(name);
    if (hookName[0] === '$') return;
    const oldListener = mapGet(oldHooks, name);
    if (listener === oldListener) return;
    removeListener(target, hookName, oldListener);
    addListener(target, hookName, listener);
  }

  function removeStaleListener(name, oldListener, target, newHooks) {
    const hookName = convertHookName(name);
    if (hookName[0] === '$' || mapGet(newHooks, name) !== undefined) return;
    removeListener(target, hookName, oldListener);
  }

  function reconcileListeners(target, hooks) {
    const state = target[NODE_STATE];
    const newHooks = hooks ?? EMPTY_MAP;

    if (!state.vdom) {
      mapEach(newHooks, addInitialListener, target);
      return;
    }

    const oldHooks = state.vdom.hooks ?? EMPTY_MAP;
    mapEach(newHooks, swapListener, target, oldHooks);
    mapEach(oldHooks, removeStaleListener, target, newHooks);
  }

  function reconcileNode(target) {
    const state = target[NODE_STATE];
    const newVdom = state.newVdom;
    const oldVdom = state.vdom;
    const args = newVdom.args;

    switch (newVdom.type) {
      case ELEMENT_NODE: {
        reconcileElementProps(target, newVdom.p ?? EMPTY_MAP);
        reconcileElementSpecials(target, newVdom.$, oldVdom?.$);
        reconcileElementChildren(target, flattenVNodeChildren(args));
        break;
      }
      case OPAQUE_NODE: {
        reconcileElementProps(target, newVdom.p ?? EMPTY_MAP);
        reconcileElementSpecials(target, newVdom.$, oldVdom?.$);
        break;
      }
      case ALIAS_NODE: {
        const innerVdom = newVdom.tag.apply(target, newVdom.args);
        if (isBlank(innerVdom)) {
          reconcileElementChildren(target, []);
        } else if (isSeq(innerVdom)) {
          reconcileElementChildren(target, flattenSeq(innerVdom, true));
        } else {
          reconcileElementChildren(target, [innerVdom]);
        }
        break;
      }
      case SPECIAL_NODE: {
        try {
          newVdom.tag.update?.(target, newVdom.args, oldVdom?.args);
        } catch (err) {
          console.error(err);
        }
        break;
      }
    }

    if (newVdom.hooks || oldVdom?.hooks) {
      reconcileListeners(target, newVdom.hooks ?? EMPTY_MAP);
    }
    try {
      newVdom.hooks?.$update?.(target, newVdom, oldVdom);
    } catch (err) {
      console.error(err);
    }
    state.vdom = newVdom;
    delete state.newVdom;
  }

  function createNode(parentNode, vdom) {
    if (typeof vdom !== 'object' || vdom === null) {
      return parentNode.ownerDocument.createTextNode(toText(vdom));
    }

    let domNode;
    switch (vdom.type) {
      case ELEMENT_NODE:
      case OPAQUE_NODE:
        domNode = createElementNode(parentNode, vdom.tag, vdom);
        break;
      case ALIAS_NODE:
        domNode = createElementNode(parentNode, 'udom-alias', vdom);
        domNode.style.display = 'contents';
        break;
      case SPECIAL_NODE:
        domNode = createElementNode(parentNode, 'udom-special', vdom);
        domNode.style.display = 'contents';
        break;
      default:
        throw new Error('Invalid VDOM node');
    }
    return domNode;
  }

  function cleanupTargetChildren(target) {
    if (target.children) {
      for (const child of target.children) {
        cleanupTarget(child);
      }
    }
  }

  function cleanupTarget(target) {
    const state = target[NODE_STATE];
    if (!state) {
      return;
    }

    const {vdom} = state;
    if (!vdom) {
      // The node was created but never reconciled (a builder threw part way
      // through); there is nothing attached to tear down.
      delete target[NODE_STATE];
      return;
    }

    if (vdom.hooks) {
      reconcileListeners(target, EMPTY_MAP);
    }

    if (vdom.type === ELEMENT_NODE || vdom.type === OPAQUE_NODE) {
      reconcileElementProps(target, EMPTY_MAP);
      reconcileElementSpecials(target, undefined, vdom.$);
    }

    if (vdom.type === ELEMENT_NODE || vdom.type === ALIAS_NODE) {
      cleanupTargetChildren(target);
    }

    delete target[NODE_STATE];

    try {
      if (vdom.type === SPECIAL_NODE) {
        vdom.tag.detach?.(target);
      }
      vdom.hooks?.$detach?.(target);
    } catch (err) {
      console.error(err);
    }
  }

  // Chained specials are compared facet by facet rather than as one object, so
  // that a `.style()` map rebuilt with the same contents compares equal instead
  // of differing by identity.
  function specialsChanged(oldSpecials, newSpecials) {
    // Both undefined for any node that chains nothing, which is most of them.
    if (oldSpecials === newSpecials) return false;
    if (!oldSpecials || !newSpecials) return true;
    return (
      shouldUpdate(oldSpecials.styling, newSpecials.styling) ||
      shouldUpdate(oldSpecials.classes, newSpecials.classes) ||
      shouldUpdate(oldSpecials.attrs, newSpecials.attrs) ||
      shouldUpdate(oldSpecials.dataset, newSpecials.dataset)
    );
  }

  // A reused node only needs a second pass when something it carries changed.
  // Props and specials are compared as maps in their own right, so an object
  // literal rebuilt with the same contents each render costs nothing; hooks are
  // compared so that a node whose props are stable but whose listeners are
  // freshly bound still gets those listeners swapped.
  function vnodeChanged(oldVdom, newVdom) {
    return (
      shouldUpdate(oldVdom.args, newVdom.args) ||
      shouldUpdate(oldVdom.p, newVdom.p) ||
      shouldUpdate(oldVdom.hooks, newVdom.hooks) ||
      specialsChanged(oldVdom.$, newVdom.$)
    );
  }

  function claimExistingNode(domNode, newVdom) {
    const state = domNode[NODE_STATE];
    if (vnodeChanged(state.vdom, newVdom)) {
      state.newVdom = newVdom;
    }
    return domNode;
  }

  function collectOldChildren(target) {
    // Keyed by vdom tag; each bucket keeps a native Map of key -> nodes so that
    // user supplied keys such as 'constructor' or '__proto__' cannot collide
    // with Object.prototype. `cursor` replaces Array#shift, which would make
    // reconciling a long unkeyed list quadratic.
    const byTag = new Map();
    const textNodes = {nodes: [], cursor: 0};

    for (const oldChild of target.childNodes) {
      if (oldChild.nodeType === 3 /* TEXT_NODE */) {
        textNodes.nodes.push(oldChild);
        continue;
      }

      const oldChildState = oldChild[NODE_STATE];
      const vdom = oldChildState?.vdom;
      if (vdom === undefined) {
        if (oldChildState?.newVdom) {
          throw new Error(
            'Attempt to reconcile against a target while already working on a reconciliation against that same target, this is not allowed',
          );
        }
        continue;
      }

      let poolForTag = byTag.get(vdom.tag);
      if (!poolForTag) {
        poolForTag = {nodesForKey: null, nodesWithoutKey: {nodes: [], cursor: 0}};
        byTag.set(vdom.tag, poolForTag);
      }

      if (vdom.k !== undefined) {
        if (!poolForTag.nodesForKey) poolForTag.nodesForKey = new Map();
        const nodesForKey = poolForTag.nodesForKey.get(vdom.k);
        if (nodesForKey) {
          nodesForKey.nodes.push(oldChild);
        } else {
          poolForTag.nodesForKey.set(vdom.k, {nodes: [oldChild], cursor: 0});
        }
      } else {
        poolForTag.nodesWithoutKey.nodes.push(oldChild);
      }
    }

    return {byTag, textNodes};
  }

  function takeFromPool(pool) {
    if (!pool || pool.cursor >= pool.nodes.length) return undefined;
    return pool.nodes[pool.cursor++];
  }

  // Places children in order by closing in from both ends at once.
  //
  // A single cursor walking front to back cannot get past a node that belongs
  // much later: it stays parked there while every node that should precede it
  // is moved in front of it, one at a time. Swapping the second and the second
  // to last of a thousand children cost 997 moves that way, where two will do.
  // Matching at the tail as well as the head means a node that belongs at the
  // far end is recognised as such and moved once.
  //
  // The invariant is that `newDomChildren[0..start-1]` are already in place at
  // the front and `newDomChildren[end+1..]` at the back, `head` is the first
  // child belonging to neither, and `suffix` is the first child of the placed
  // tail — which is also where anything inserted at the end belongs.
  function placeChildren(target, newDomChildren, insertBefore, moveBefore) {
    let start = 0;
    let end = newDomChildren.length - 1;
    let head = target.firstChild;
    let suffix = null;

    while (start <= end) {
      const wantedFirst = newDomChildren[start];
      const wantedLast = newDomChildren[end];
      const tail = suffix ? suffix.previousSibling : target.lastChild;

      if (wantedFirst === head) {
        head = head.nextSibling;
        start++;
      } else if (wantedLast === tail) {
        suffix = tail;
        end--;
      } else if (wantedLast === head) {
        // The node at the front belongs at the back of what is left. Both this
        // and the branch below need two or more children still unplaced, which
        // the checks above guarantee: with only one left, head is tail.
        const next = head.nextSibling;
        placeNode(target, head, suffix, insertBefore, moveBefore);
        suffix = head;
        head = next;
        end--;
      } else if (wantedFirst === tail) {
        // ...and the reverse, which together are what a swap looks like.
        placeNode(target, tail, head, insertBefore, moveBefore);
        start++;
      } else {
        // Neither end matches: put the wanted node at the front of the gap.
        // Once nothing is left between, `head` has advanced onto the placed
        // suffix, or onto null, which is where a new node belongs anyway.
        placeNode(target, wantedFirst, head, insertBefore, moveBefore);
        start++;
      }
    }
  }

  // Same result, but reached without ever passing the focused child to
  // insertBefore. Detaching a focused node blurs it, so instead it is treated
  // as a fixed anchor and every other child is arranged around it: the children
  // that belong before it are placed immediately before it, and the rest are
  // walked into place after it. The anchor still ends up at its correct index,
  // because exactly the right number of children end up on either side.
  //
  // Only needed where `moveBefore` is unavailable — it relocates a node without
  // detaching it, so focus survives an ordinary move.
  function placeChildrenAroundAnchor(target, newDomChildren, insertBefore, anchorIndex) {
    const anchor = newDomChildren[anchorIndex];

    // Right to left, so each child lands directly before the one that follows it.
    let before = anchor;
    for (let i = anchorIndex - 1; i >= 0; i--) {
      const child = newDomChildren[i];
      if (child !== before.previousSibling) {
        insertBefore.call(target, child, before);
      }
      before = child;
    }

    // Left to right over whatever still follows the anchor. Children that were
    // stranded on the other side of it get pulled across here.
    let ref = anchor.nextSibling;
    for (let i = anchorIndex + 1; i < newDomChildren.length; i++) {
      const child = newDomChildren[i];
      if (child === ref) {
        ref = ref.nextSibling;
      } else {
        insertBefore.call(target, child, ref);
      }
    }
  }

  // At most one child of a given parent can be on the focus path, so there is
  // never more than one anchor to preserve.
  function findFocusedChildIndex(newDomChildren, focusWithin) {
    for (let i = 0; i < newDomChildren.length; i++) {
      if (focusWithin.has(newDomChildren[i])) return i;
    }
    return -1;
  }

  function attachAndReconcile(newChild) {
    const state = newChild[NODE_STATE];
    if (!state?.newVdom) return;
    if (!state.vdom) {
      try {
        state.newVdom.hooks?.$attach?.(newChild);
        if (state.newVdom.type === SPECIAL_NODE) {
          state.newVdom.tag.attach?.(newChild);
        }
      } catch (err) {
        console.error(err);
      }
    }
    reconcileNode(newChild);
  }

  function reconcileElementChildren(target, newChildren) {
    const oldNodesToRemove = target.firstChild ? new Set(target.childNodes) : null;
    const {byTag, textNodes} = collectOldChildren(target);

    const newDomChildren = [];
    for (const newVdom of newChildren) {
      let newDomNode;
      if (newVdom instanceof VNode) {
        const poolForTag = byTag.get(newVdom.tag);
        const reusable = poolForTag
          ? takeFromPool(
              newVdom.k !== undefined
                ? poolForTag.nodesForKey?.get(newVdom.k)
                : poolForTag.nodesWithoutKey,
            )
          : undefined;
        newDomNode = reusable ? claimExistingNode(reusable, newVdom) : createNode(target, newVdom);
      } else {
        const reusableText = takeFromPool(textNodes);
        const text = toText(newVdom);
        if (reusableText) {
          newDomNode = reusableText;
          if (newDomNode.nodeValue !== text) newDomNode.nodeValue = text;
        } else {
          newDomNode = target.ownerDocument.createTextNode(text);
        }
      }
      oldNodesToRemove?.delete(newDomNode);
      newDomChildren.push(newDomNode);
    }

    if (oldNodesToRemove) {
      for (const nodeToRemove of oldNodesToRemove) {
        cleanupTarget(nodeToRemove);
        target.removeChild(nodeToRemove);
      }
    }

    if (newDomChildren.length === 0) return;

    const doc = target.ownerDocument;
    const insertBefore = nodePrototypeFor(doc, userSettings?.window).insertBefore;
    const moveBefore = parentMoveBeforeFor(target, doc, userSettings?.window);
    const connected = target.isConnected;

    let anchorIndex = -1;
    if (connected && !moveBefore) {
      const focusWithin = documentToFocusWithinSet.get(doc) ?? installFocusTrackingForDocument(doc);
      anchorIndex = findFocusedChildIndex(newDomChildren, focusWithin);
      // A focused child is always one we pooled from the existing children, so
      // it is already under this target. The guard is only here so that a
      // surprising focus set can never turn into a thrown insertBefore.
      if (anchorIndex !== -1 && newDomChildren[anchorIndex].parentNode !== target) {
        anchorIndex = -1;
      }
    }

    if (anchorIndex === -1) {
      placeChildren(target, newDomChildren, insertBefore, connected ? moveBefore : null);
    } else {
      placeChildrenAroundAnchor(target, newDomChildren, insertBefore, anchorIndex);
    }

    // Placement happens first so that lifecycle hooks and alias builders run
    // against a fully arranged sibling list rather than a half built one.
    for (let i = 0; i < newDomChildren.length; i++) {
      attachAndReconcile(newDomChildren[i]);
    }
  }

  function reconcile(target, vdom) {
    const state = target[NODE_STATE];
    if (vdom === null || vdom === undefined) {
      if (state) {
        cleanupTarget(target);
      } else {
        cleanupTargetChildren(target);
      }
      target.replaceChildren();
      return;
    }

    if (isSeq(vdom)) {
      reconcileElementChildren(target, flattenSeq(vdom, true));
      return;
    }

    if (vdom instanceof VNode) {
      // `state.vdom` rather than `state`: a target whose first reconciliation
      // threw part way through is left holding a state with no vdom in it, and
      // it has nothing attached that a retry needs to preserve. Claiming it
      // afresh restarts cleanly, where reading through the missing vdom would
      // report a null dereference on top of whatever actually went wrong.
      if (state?.vdom) {
        // The tag has to match as well as the type: swapping the alias function
        // or the special descriptor is a different component, and reusing the
        // state would skip the old one's detach and the new one's attach.
        if (state.vdom.type === vdom.type && state.vdom.tag === vdom.tag) {
          if (vnodeChanged(state.vdom, vdom)) {
            state.newVdom = vdom;
            reconcileNode(target);
          }
          return;
        }
        cleanupTarget(target);
      }

      switch (vdom.type) {
        case ELEMENT_NODE:
        case OPAQUE_NODE:
          if (!sameTagName(target.nodeName, convertTagName(vdom.tag))) {
            throw new Error('incompatible target for vdom');
          }
          break;
      }

      target[NODE_STATE] = newNodeState(vdom);
      try {
        vdom.hooks?.$attach?.(target);
        if (vdom.type === SPECIAL_NODE) {
          vdom.tag.attach?.(target);
        }
      } catch (err) {
        console.error(err);
      }
      reconcileNode(target);
      return;
    }

    throw new Error('invalid vdom');
  }

  return {
    h,
    alias,
    special,
    reconcile,
    settings: {
      shouldUpdate,
      isMap,
      mapIter,
      mapEach,
      mapGet,
      mapMerge,
      newMap,
      mapPut,
      isSeq,
      flattenSeq,
      seqIter,
      convertTagName,
      convertPropName,
      convertStyleName,
      convertDataName,
      convertClassName,
      convertHookName,
      convertName,
      listenerKey,
      captureKey,
      passiveKey,
    },
  };
};

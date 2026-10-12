/**
 * Realm helpers shared by the optional DOM-facing modules.
 *
 * Everything here resolves browser APIs from the element's *own* realm rather
 * than from globals, so an element inside an iframe is handled by that iframe's
 * implementation, and a test environment whose DOM is not installed globally
 * works without extra wiring.
 */

export function windowFor(element, override) {
  return override ?? element?.ownerDocument?.defaultView ?? globalThis;
}

export function requireConstructor(view, name) {
  const Ctor = view?.[name];
  if (typeof Ctor !== 'function') {
    throw new Error(`${name} is not available in this environment`);
  }
  return Ctor;
}

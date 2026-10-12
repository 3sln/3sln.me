/**
 * Shared settings resolution for dodo's optional modules.
 *
 * The modules follow the same factory shape as the rest of the project: you
 * hand a factory a `userSettings` object carrying a `dodo` instance, and it
 * returns a configured API.
 *
 *     const {watch} = reactive({dodo});
 *     const {withContext, useContext} = context({dodo, reactive: {watch}});
 *
 * Dependencies between modules are injected, not discovered. `context` renders
 * through a `watch`, so it takes one — build it once and pass it in. That
 * matters more than it looks: a `special` component's identity *is* its
 * descriptor object, and the reconciler uses that identity to decide whether a
 * DOM node can be reused, so two independently built `watch` components would
 * never reuse each other's nodes.
 *
 * As a convenience a bare dodo instance is accepted in place of the settings
 * object:
 *
 *     const {watch} = reactive(dodo);
 */

function microtaskSchedule(fn, {signal} = {}) {
  queueMicrotask(() => {
    if (!signal?.aborted) fn();
  });
}

function defaultRenderError(h) {
  return error =>
    h(
      'pre',
      h('strong', `Error: ${error?.message ?? String(error)}`),
      '\n\n',
      error?.stack ?? '',
    ).style({
      'background-color': '#fdd',
      color: '#330',
      padding: '1em',
      'white-space': 'pre-wrap',
    });
}

function looksLikeDodo(value) {
  return (
    value != null && typeof value.special === 'function' && typeof value.reconcile === 'function'
  );
}

/**
 * Merges user settings with defaults.
 *
 * | setting       | default                                     |
 * | ------------- | ------------------------------------------- |
 * | `dodo`        | required                                     |
 * | `schedule`    | the instance's `schedule`, else a microtask  |
 * | `renderError` | a `<pre>` with the message and stack         |
 */
export function settings(userSettings) {
  const source = looksLikeDodo(userSettings) ? {dodo: userSettings} : userSettings;
  const dodo = source?.dodo;
  if (!looksLikeDodo(dodo)) {
    throw new Error('a dodo instance must be provided in settings, e.g. reactive({dodo})');
  }

  return {
    // Rendering is scheduled rather than run inline so that a burst of changes
    // collapses into one pass. Replace it to render synchronously, to render on
    // idle, or to drive frames from a test.
    schedule: typeof dodo.schedule === 'function' ? dodo.schedule : microtaskSchedule,
    renderError: defaultRenderError(dodo.h),
    ...source,
    dodo,
    // Map handling and change detection always come from the dodo instance. A
    // module that disagreed with its renderer about what a map is would be
    // worse than useless, so these are not overridable here.
    ...dodo.settings,
  };
}

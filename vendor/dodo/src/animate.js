/**
 * Optional enter/exit animation for dodo.
 *
 * Two layers, as with `observe`:
 *
 *   - **`runAnimation(element, spec, options)`** — a plain, cancellable promise
 *     over one animation. No dodo dependency.
 *   - **`withPresence(isPresent, builder, config?)`** — a component that drives
 *     an element through spawn and despawn, rendering its phase.
 *
 * The phases are `'spawning'`, `'spawned'`, `'despawning'` and `'despawned'`,
 * and `builder` receives whichever is current.
 *
 * Everything is driven by an `AbortSignal`. Toggling presence mid-animation
 * aborts the animation in flight rather than letting it land later and clobber
 * the newer state, and detaching aborts it too.
 */

import {cell} from './reactive.js';
import {settings as resolveSettings} from './settings.js';
import {windowFor} from './dom.js';

export const SPAWNING = 'spawning';
export const SPAWNED = 'spawned';
export const DESPAWNING = 'despawning';
export const DESPAWNED = 'despawned';

function parseTimeList(value) {
  if (!value) return [0];
  return value.split(',').map(part => {
    const time = part.trim();
    const amount = Number.parseFloat(time);
    if (!Number.isFinite(amount)) return 0;
    return time.endsWith('ms') ? amount : amount * 1000;
  });
}

function longestOf(durations, delays) {
  const times = parseTimeList(durations);
  const offsets = parseTimeList(delays);
  let longest = 0;
  for (let i = 0; i < times.length; i++) {
    longest = Math.max(longest, times[i] + (offsets[i % offsets.length] ?? 0));
  }
  return longest;
}

/**
 * How long the element's CSS transitions and animations will actually take,
 * read after the phase's classes have been applied.
 *
 * This is what removes the whole class of hangs that waiting on `transitionend`
 * invites: a transition that never starts, a property that did not change, or a
 * multi-property transition that fires several events. The declared duration is
 * knowable, so it is used directly and no listener is registered at all.
 */
export function computedAnimationDuration(element, {window: override} = {}) {
  const view = windowFor(element, override);
  const measure = target => {
    const style = view.getComputedStyle?.(target);
    if (!style) return 0;
    return Math.max(
      longestOf(style.transitionDuration, style.transitionDelay),
      longestOf(style.animationDuration, style.animationDelay),
    );
  };

  // The element's own children count too. A presence wrapper is very often
  // `display: contents` with the transition declared on the content inside it,
  // and measuring only the wrapper would report zero and skip the animation
  // entirely — a silent no-op, which is far worse than an overestimate.
  let longest = measure(element);
  for (const child of element.children ?? []) {
    longest = Math.max(longest, measure(child));
  }
  return longest;
}

function applyStyles(element, classes, styling) {
  if (classes) {
    for (const name of classes) {
      if (name) element.classList.add(name);
    }
  }
  if (styling) {
    for (const [name, value] of Object.entries(styling)) {
      element.style.setProperty(name, value);
    }
  }
}

function removeStyles(element, classes, styling) {
  if (classes) {
    for (const name of classes) {
      if (name) element.classList.remove(name);
    }
  }
  if (styling) {
    for (const name of Object.keys(styling)) {
      element.style.removeProperty(name);
    }
  }
}

function whenAborted(signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), {once: true});
  });
}

/**
 * Reaching a genuinely *later* frame, which is not the same thing as dodo's
 * scheduler.
 *
 * `runQueue` drains everything queued while it is draining, so work queued from
 * inside a render lands in that same frame. For a render that is deferred
 * through the scheduler — which is every reactive render — the element would
 * then be created and styled without ever being painted at its starting state,
 * and the transition would have nothing to run from.
 *
 * A `requestAnimationFrame` registered from inside a frame callback runs in the
 * next frame, which is exactly the guarantee needed.
 */
function nextFrame(element, override) {
  const view = windowFor(element, override);
  return fn =>
    typeof view.requestAnimationFrame === 'function'
      ? view.requestAnimationFrame(() => fn())
      : setTimeout(fn, 16);
}

/**
 * Runs one animation over `element` and resolves when it is done.
 *
 * `spec` is a plain object:
 *
 * | field       | meaning                                                     |
 * | ----------- | ------------------------------------------------------------ |
 * | `classes`   | class names added for the duration, then removed              |
 * | `styling`   | CSS properties (kebab-case) applied, then removed             |
 * | `animation` | `{keyframes, options}` handed to `Element.animate`             |
 * | `fn`        | `(element, {signal}) => Promise` for anything else             |
 * | `duration`  | overrides the duration read from computed style, in ms         |
 *
 * Classes and styling are applied on the next frame, not immediately: an
 * element that was inserted in this frame has no previously rendered style to
 * transition *from*, so applying in the same tick produces a jump rather than
 * an animation.
 *
 * | option     | meaning                                                     |
 * | ---------- | ------------------------------------------------------------ |
 * | `signal`   | cancels the animation and undoes what it applied              |
 * | `frame`    | how a genuinely later frame is reached, defaults to `rAF`     |
 * | `restore`  | remove the applied styles on completion, `true` by default    |
 * | `replace`  | a previous spec whose styles are removed as these are applied |
 * | `window`   | override the realm                                            |
 *
 * `restore` is what a standalone animation wants — a shake leaves no trace. A
 * transition *between states* wants the opposite: its end state is the new
 * resting state, and removing it snaps the element back to where it started.
 * `withPresence` passes `restore: false` and uses `replace` so the outgoing
 * phase's styles come off in the same frame the incoming phase's go on.
 */
export async function runAnimation(element, spec, options = {}) {
  const {
    signal,
    window: override,
    frame = nextFrame(element, override),
    restore = true,
    replace = null,
  } = options;
  if (!element || !spec || signal?.aborted) return;

  const {classes, styling, animation, fn, duration} = spec;
  const view = windowFor(element, override);
  const cleanups = [];
  const pending = [];

  let cleaned = false;
  let undoStyles = null;
  const cleanup = aborted => {
    if (cleaned) return;
    cleaned = true;
    for (const undo of cleanups) {
      try {
        undo();
      } catch (err) {
        console.error('Error cleaning up an animation:', err);
      }
    }
    // An abandoned phase always undoes itself, whatever `restore` says: its
    // styles describe a state the element is no longer heading towards.
    if (undoStyles && (aborted || restore)) undoStyles();
  };
  // Cleaning up on the abort itself rather than waiting for the await to
  // unwind: a reversal applies the opposite phase's classes immediately, and
  // this phase's must already be gone by then.
  signal?.addEventListener('abort', () => cleanup(true), {once: true});

  try {
    if (typeof fn === 'function') {
      pending.push(Promise.resolve(fn(element, {signal})));
    }

    if (animation && typeof element.animate === 'function') {
      const player = element.animate(animation.keyframes, animation.options);
      cleanups.push(() => {
        if (player.playState !== 'finished') player.cancel();
      });
      // `finished` rejects when an animation is cancelled, which is an ordinary
      // outcome here rather than a failure.
      pending.push(Promise.resolve(player.finished).catch(() => {}));
    }

    if ((classes && classes.length) || styling) {
      pending.push(
        new Promise(resolve => {
          frame(() => {
            if (cleaned || signal?.aborted) return resolve();
            // Same frame, so swapping phases never shows a frame of neither.
            if (replace) removeStyles(element, replace.classes, replace.styling);
            applyStyles(element, classes, styling);
            undoStyles = () => removeStyles(element, classes, styling);

            const ms = duration ?? computedAnimationDuration(element, {window: override});
            if (!(ms > 0)) return resolve();
            const timer = view.setTimeout(resolve, ms);
            cleanups.push(() => view.clearTimeout(timer));
          });
        }),
      );
    }

    const work = Promise.all(pending);
    if (signal) {
      await Promise.race([work, whenAborted(signal)]);
    } else {
      await work;
    }
  } finally {
    cleanup(false);
  }
}

const PRESENCE_STATE = Symbol('dodo.animate.presence');

/**
 * Builds the presence component.
 *
 *     const {withPresence} = animate({dodo, reactive});
 *
 * Takes the same settings as `reactive`, plus a required `reactive` API.
 */
export default function animateFactory(userSettings) {
  const settings = resolveSettings(userSettings);
  const {dodo, reactive, frame} = settings;
  const {special, reconcile} = dodo;

  if (typeof reactive?.watch !== 'function') {
    throw new Error(
      'animate() requires a reactive API providing a watch component, ' +
        'e.g. animate({dodo, reactive: reactive({dodo})})',
    );
  }
  const {watch} = reactive;
  const rawMapGet = settings.mapGet ?? ((m, k) => m[k]);
  const mapGet = (map, key) => (map == null ? undefined : rawMapGet(map, key));
  const mapIter = settings.mapIter ?? (m => Object.entries(m));

  function toPlainObject(map) {
    if (map == null) return undefined;
    const plain = {};
    for (const [name, value] of mapIter(map)) plain[name] = value;
    return plain;
  }

  // A fresh object every time, deliberately. Bones reused one shared result
  // object here, so every element built from a factory ended up sharing the
  // most recently attached element's config.
  function readSpec(spec) {
    if (spec == null) return null;
    const animation = mapGet(spec, 'animation');
    return {
      classes: mapGet(spec, 'classes'),
      styling: toPlainObject(mapGet(spec, 'styling')),
      animation: animation && {
        keyframes: mapGet(animation, 'keyframes'),
        options: mapGet(animation, 'options'),
      },
      fn: mapGet(spec, 'fn'),
      duration: mapGet(spec, 'duration'),
    };
  }

  /**
   * `withPresence(isPresent, builder, config?)`.
   *
   * | config      | meaning                                                  |
   * | ----------- | -------------------------------------------------------- |
   * | `spawn`     | the animation spec for entering                           |
   * | `despawn`   | the animation spec for leaving                            |
   * | `mode`      | `'remove'` renders nothing once despawned                 |
   * | `display`   | the display given to the node while present, `block`      |
   */
  const withPresence = special({
    attach(element) {
      element[PRESENCE_STATE] = {
        phase: cell(DESPAWNED),
        controller: null,
        applied: null,
      };
      element.dataset.presence = DESPAWNED;
    },

    // The phase is mirrored onto the node as `data-presence` so that CSS has a
    // stable hook on the wrapper itself — there is otherwise no way to write a
    // rule for it, since the element is created by the reconciler.
    setPhase(element, state, phase) {
      element.dataset.presence = phase;
      state.phase.setValue(phase);
    },

    update(element, [isPresent, builder, config], oldArgs) {
      const state = element[PRESENCE_STATE];
      if (!state) return;

      const present = !!isPresent;
      const wasPresent = oldArgs ? !!oldArgs[0] : null;
      if (wasPresent === null) {
        // First render: enter animates, absent starts hidden and silent.
        if (present) this.transition(element, true, config);
        else element.style.display = 'none';
      } else if (present !== wasPresent) {
        this.transition(element, present, config);
      }

      const removeWhenGone = mapGet(config, 'mode') === 'remove';
      reconcile(element, [
        watch(state.phase, phase =>
          removeWhenGone && phase === DESPAWNED ? null : builder(phase),
        ),
      ]);
    },

    transition(element, present, config) {
      const state = element[PRESENCE_STATE];

      // Whatever was in flight is now stale. Aborting it stops its timers,
      // cancels its Web Animation, undoes its classes, and — critically — makes
      // its completion a no-op, so it cannot land after this one and win.
      state.controller?.abort();
      const controller = new AbortController();
      state.controller = controller;

      if (present) {
        element.style.display = mapGet(config, 'display') ?? 'block';
      }
      this.setPhase(element, state, present ? SPAWNING : DESPAWNING);

      const spec = readSpec(mapGet(config, present ? 'spawn' : 'despawn'));
      const outgoing = state.applied;
      state.applied = spec;

      runAnimation(element, spec, {
        signal: controller.signal,
        // Deliberately not the dodo scheduler: see `nextFrame`. Overridable so
        // a test can apply styles synchronously.
        frame,
        // A phase's end state is the element's new resting state, so it stays
        // put; the opposite phase removes it when it takes over.
        restore: false,
        replace: outgoing,
      })
        .catch(err => console.error('Error in presence animation:', err))
        .then(() => {
          if (controller.signal.aborted) return;
          // The element may have been detached while animating.
          if (element[PRESENCE_STATE] !== state) return;
          state.controller = null;
          this.setPhase(element, state, present ? SPAWNED : DESPAWNED);
          if (!present) element.style.display = 'none';
        });
    },

    detach(element) {
      const state = element[PRESENCE_STATE];
      state?.controller?.abort();
      delete element[PRESENCE_STATE];
      // Bones left this out, so nothing below a presence node ever saw its
      // `$detach` hook and its listeners stayed attached.
      reconcile(element, null);
    },
  });

  return {withPresence};
}

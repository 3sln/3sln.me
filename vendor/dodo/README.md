# Dodo

> [!WARNING]
> This is a work-in-progress project and is not yet ready for production use.

A minimal, configurable virtual DOM library.

## Documentation

For detailed documentation, live demos, and advanced usage examples, please check out the [Dodo Deck](https://dodo.3sln.com).

## Quick Start

Installation:
```shell
npm install @3sln/dodo
# or
bun add @3sln/dodo
# or
yarn add @3sln/dodo
```

Basic usage:
```javascript
import { reconcile, h1, p, div } from '@3sln/dodo';

const container = document.getElementById('root');

// Use helper functions like h1(), p(), etc. for standard elements.
// A tag is followed by its children, and nothing else.
const myVdom = div(
  h1('Hello, dodo!'),
  p('This is a paragraph.').classes('lede')
).props({ id: 'app' });

// Reconcile the virtual DOM with the real DOM.
reconcile(container, [myVdom]);
```

Everything about an element — its properties included — is chained onto the
vnode, and every setter returns the vnode:

```javascript
div('content')
  .props({ id: 'card' })
  .style({ 'background-color': 'white', padding: '1em' })
  .classes('card', isActive && 'active')
  .attrs({ role: 'group' })
  .data({ cardId: id })
  .key(id)
  .on({ click: onClick });
```

Each map is compared in its own right rather than by identity, so an object
literal rebuilt every render compares equal when its contents have not changed.

## Optional modules

Five modules ship alongside the core. Dodo's core does not import any of them,
so they cost nothing if you do not use them.

### Reactivity — `@3sln/dodo/reactive`

Reactive rendering built on a two method `Cell` protocol:

```javascript
{ onDirty(fn) -> unsubscribe, getValue() -> any }
```

Dodo does not depend on the observable protocol, on signals, or on any other
library — it depends on this. Adapters bridge the rest (`fromObservable`,
`fromSubscribe`, `fromSignal`), and `cell()` is there if you would rather not
bring anything at all.

```javascript
import {reconcile, p} from '@3sln/dodo';
import {cell, watch} from '@3sln/dodo/reactive';

const name = cell('world');

reconcile(container, [watch(name, value => p(`hello ${value}`))]);

name.setValue('dodo'); // re-renders on the next frame
```

### Context — `@3sln/dodo/context`

DOM-scoped context, so data reaches a descendant without passing through every
component in between. Providers respect shadow DOM boundaries, and consumers
name the keys they care about so unrelated changes do not re-render them.

```javascript
import {withContext, useContext} from '@3sln/dodo/context';

withContext({theme: 'dark'},
  someDeeplyNestedTree(
    useContext(['theme'], ({theme}) => p(`theme is ${theme}`)),
  ),
)
```

### Observing elements — `@3sln/dodo/observe`

`ResizeObserver` and `IntersectionObserver` as Cells, plus two components built
on them. Observers connect on the first listener and disconnect on the last, so
a detached `watch` takes its observer with it.

```javascript
import {withElementSize, withVisibility} from '@3sln/dodo/observe';

withElementSize(size => canvas().props({width: size.width, height: size.height}))

withVisibility(visible => (visible ? chart() : skeleton()), {root: '.scroller'})
```

The underlying `elementSize` / `elementVisibility` cells are plain functions of
an element with no dependency on dodo, usable on their own.

### Enter and exit animation — `@3sln/dodo/animate`

Holds an element on screen long enough to animate out, reporting which phase of
appearing or disappearing it is in. Reversing mid-animation aborts whatever was
in flight, so a stale completion cannot land later and win.

```javascript
import {withPresence} from '@3sln/dodo/animate';

withPresence(isOpen, phase => panel({phase}), {
  spawn: {classes: ['fade-in']},
  despawn: {classes: ['fade-out']},
  mode: 'remove',
})
```

Durations are read from computed style rather than waited on with
`transitionend`, so a transition that never fires cannot leave a phase stuck.

### Scoped styling — `@3sln/dodo/style`

Renders a subtree into a shadow root with constructable stylesheets adopted, so
its CSS genuinely cannot leak in either direction.

```javascript
import {css, scoped} from '@3sln/dodo/style';

const styles = css`p { color: rebeccapurple; }`;

scoped({styleSheets: [styles]}, p('scoped'))
```

`css` is memoised per call site, so writing it inline in a render function does
not rebuild the sheet every time.

### Baking your own

The modules follow the same factory pattern as the rest of the project. If you
use a custom dodo instance, or want to replace the scheduler or the error view,
build your own. Context renders through a `watch`, so it requires the reactive
API to be injected — build it once and pass it in:

```javascript
import reactive from '@3sln/dodo/src/reactive.js';
import context from '@3sln/dodo/src/context.js';

const userSettings = {dodo: myDodo, schedule: fn => fn()};

const {watch} = reactive(userSettings);
const {withContext, useContext} = context({...userSettings, reactive: {watch}});
```
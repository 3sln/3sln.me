// Helpers take children only; properties are chained on with `.props()`. The
// void elements therefore take nothing at all, which is what keeps them from
// being handed children they cannot have.
export default function htmlFactory({h}) {
  return {
    // Document metadata
    title: (...args) => h('title', ...args),
    meta: () => h('meta'),
    link: () => h('link'),
    style: (...args) => h('style', ...args),
    script: (...args) => h('script', ...args),
    noscript: (...args) => h('noscript', ...args),

    // Content sectioning
    address: (...args) => h('address', ...args),
    article: (...args) => h('article', ...args),
    aside: (...args) => h('aside', ...args),
    footer: (...args) => h('footer', ...args),
    header: (...args) => h('header', ...args),
    h1: (...args) => h('h1', ...args),
    h2: (...args) => h('h2', ...args),
    h3: (...args) => h('h3', ...args),
    h4: (...args) => h('h4', ...args),
    h5: (...args) => h('h5', ...args),
    h6: (...args) => h('h6', ...args),
    main: (...args) => h('main', ...args),
    nav: (...args) => h('nav', ...args),
    section: (...args) => h('section', ...args),

    // Text content
    blockquote: (...args) => h('blockquote', ...args),
    dd: (...args) => h('dd', ...args),
    div: (...args) => h('div', ...args),
    dl: (...args) => h('dl', ...args),
    dt: (...args) => h('dt', ...args),
    figcaption: (...args) => h('figcaption', ...args),
    figure: (...args) => h('figure', ...args),
    hr: () => h('hr'),
    li: (...args) => h('li', ...args),
    ol: (...args) => h('ol', ...args),
    p: (...args) => h('p', ...args),
    pre: (...args) => h('pre', ...args),
    ul: (...args) => h('ul', ...args),

    // Inline text semantics
    a: (...args) => h('a', ...args),
    abbr: (...args) => h('abbr', ...args),
    b: (...args) => h('b', ...args),
    br: () => h('br'),
    cite: (...args) => h('cite', ...args),
    code: (...args) => h('code', ...args),
    data: (...args) => h('data', ...args),
    del: (...args) => h('del', ...args),
    dfn: (...args) => h('dfn', ...args),
    em: (...args) => h('em', ...args),
    i: (...args) => h('i', ...args),
    ins: (...args) => h('ins', ...args),
    kbd: (...args) => h('kbd', ...args),
    mark: (...args) => h('mark', ...args),
    q: (...args) => h('q', ...args),
    s: (...args) => h('s', ...args),
    samp: (...args) => h('samp', ...args),
    small: (...args) => h('small', ...args),
    span: (...args) => h('span', ...args),
    strong: (...args) => h('strong', ...args),
    sub: (...args) => h('sub', ...args),
    sup: (...args) => h('sup', ...args),
    time: (...args) => h('time', ...args),
    u: (...args) => h('u', ...args),
    wbr: () => h('wbr'),

    // Image and multimedia
    area: () => h('area'),
    audio: (...args) => h('audio', ...args),
    img: () => h('img'),
    map: (...args) => h('map', ...args),
    track: () => h('track'),
    video: (...args) => h('video', ...args),

    // Embedded content
    embed: () => h('embed'),
    iframe: (...args) => h('iframe', ...args),
    object: (...args) => h('object', ...args),
    param: () => h('param'),
    picture: (...args) => h('picture', ...args),
    portal: (...args) => h('portal', ...args),
    source: () => h('source'),

    // SVG and MathML
    svg: (...args) => h('svg', ...args),
    math: (...args) => h('math', ...args),

    // Scripting
    canvas: (...args) => h('canvas', ...args),

    // Table content
    caption: (...args) => h('caption', ...args),
    col: () => h('col'),
    colgroup: (...args) => h('colgroup', ...args),
    table: (...args) => h('table', ...args),
    tbody: (...args) => h('tbody', ...args),
    td: (...args) => h('td', ...args),
    tfoot: (...args) => h('tfoot', ...args),
    th: (...args) => h('th', ...args),
    thead: (...args) => h('thead', ...args),
    tr: (...args) => h('tr', ...args),

    // Forms
    button: (...args) => h('button', ...args),
    datalist: (...args) => h('datalist', ...args),
    fieldset: (...args) => h('fieldset', ...args),
    form: (...args) => h('form', ...args),
    input: () => h('input'),
    label: (...args) => h('label', ...args),
    legend: (...args) => h('legend', ...args),
    meter: (...args) => h('meter', ...args),
    optgroup: (...args) => h('optgroup', ...args),
    option: (...args) => h('option', ...args),
    output: (...args) => h('output', ...args),
    progress: (...args) => h('progress', ...args),
    select: (...args) => h('select', ...args),
    textarea: (...args) => h('textarea', ...args),

    // Interactive elements
    details: (...args) => h('details', ...args),
    dialog: (...args) => h('dialog', ...args),
    summary: (...args) => h('summary', ...args),

    // Web Components
    slot: (...args) => h('slot', ...args),
    template: (...args) => h('template', ...args),
  };
}

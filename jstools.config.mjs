import {defineConfig} from '@3sln/js-tools';

// This is an explicit public-code boundary, not a copy of the repository.
// Staging retains repository-relative paths so authored neighbour imports keep
// their meaning when mirrored under /assets/. No source imports are rewritten.
export const publicSources = [
  'apps/web/src',
  'apps/embed',
  'vendor/dodo',
  'vendor/ngin',
  'packages/sdk/src',
  'packages/i18n',
  'packages/consent/model.mjs','packages/consent/localization.mjs','packages/consent/reviewed-contracts.mjs',
  'packages/portal',
  'packages/recovery/index.mjs',
  'packages/recovery/normalization.mjs',
  'packages/recovery/identity-backup.mjs',
  'packages/identity/handles.mjs',
  'packages/messaging/form-policy.mjs',
  'packages/messaging/tags.mjs',
  'packages/messaging/store.mjs',
  'packages/core/primitives.mjs',
  'modules/publications',
  'scripts/recovery-kdf-worker.mjs',
  'scripts/message-frame-controller.mjs',
  'scripts/message-sanitizer.mjs',
  'apps/web/styles.css',
  'packages/core/records.mjs','packages/content/form-policy.mjs',
];

export const pages = [
  {source:'apps/web/console.html',output:'console.html',entry:'app',module:'/src/main.mjs'},
  {source:'apps/web/authorize.html',output:'authorize.html',entry:'authorize',module:'/src/authorize.mjs'},
];
export const clientManifest = '.output/client-manifest.mjs';

export default defineConfig({
  src: '.output/client-source',
  out: '.output/public',
  assetRoot: 'assets',
  extensions: ['.js','.mjs'],
  // Vendored 3sln snapshots remain single source graphs with their provenance.
  // 0.2.0 requires at least one dependency entry. Explicitly allow the existing
  // browser crypto library only; never discover this repository's server deps.
  // Standalone workers bundle crypto/sanitizer dependencies without an import map.
  dependencies: ['hash-wasm'],
  entries: {
    app: {module:'apps/web/src/main.mjs',css:'apps/web/styles.css'},
    authorize: {module:'apps/web/src/authorize.mjs',css:'apps/web/styles.css'},
    // Islands shell runtime for the dedicated embed origin. build-assets re-roots its graph under /embed/assets/,
    // gives it its own static import map and adds apps/embed/styles/parts.css as the shell's second stylesheet.
    embed: {module:'apps/embed/src/boot.mjs',css:'apps/embed/styles/shell.css'},
  },
  // js-tools' standalone ESM bundler also serves public SDK entries: external
  // embedding pages have no application import map, just as workers do not.
  // These SDK entries execute in a page, not in a Worker runtime.
  workers: {
    recovery:'scripts/recovery-kdf-worker.mjs',
    messageFrame:'scripts/message-frame-controller.mjs',
    messageSanitizer:'scripts/message-sanitizer.mjs',
    sdkDefine:'packages/sdk/src/define.mjs',
    sdkCallback:'packages/sdk/src/callback.mjs',
    sdkIdentity:'packages/sdk/src/identity.mjs',
    // The island worker has no import map, so it is bundled whole (embed islands EI-13).
    embedWorker:'apps/embed/src/worker/index.mjs',
  },
  // The embed service worker is copied to /embed/sw.js with a build-derived generation, never fingerprinted.
  exclude: ['packages/recovery/vectors.mjs','apps/embed/sw.js'],
  minify: false,
  minifyCss: true,
  // Pinned 0.2.0 fingerprints .mjs but only adds .js to its import map, and its
  // graph check treats origin-absolute browser imports as filesystem paths.
  // build-assets completes that map, verifies the exact browser graph, and uses
  // js-tools' wireupSource again before publishing either manifest or HTML.
  check: false,
  manifest: null,
  copy: [
    ...['icon.svg','generic-icon.svg','manifest.webmanifest','demo.css'].map(name=>({from:`apps/web/${name}`,to:name})),
    {from:'apps/web/branding',to:'branding'},
    {from:'vendor/dodo/LICENSE',to:'vendor/dodo/LICENSE'},
    {from:'vendor/dodo/README.md',to:'vendor/dodo/README.md'},
    {from:'vendor/ngin/LICENSE',to:'vendor/ngin/LICENSE'},
    {from:'packages/i18n/vendor/bab/LICENSE',to:'packages/i18n/vendor/bab/LICENSE'},
    {from:'packages/i18n/vendor/bab/PROVENANCE.md',to:'packages/i18n/vendor/bab/PROVENANCE.md'},
    {from:'docs/artefacts',to:'artefacts'},
  ],
});

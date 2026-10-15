// Lazily imported by admin-entry.mjs once a boot session exists or administrator
// authority is confirmed. Ordinary accounts and anonymous visitors never load it,
// and the public service worker does not precache it.
export { constructors, EnterConsole } from './bl/admin-console.mjs';
export { consoleView } from './ui/admin-console.mjs';

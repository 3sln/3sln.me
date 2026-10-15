import {captureOnboardingEntry} from './providers/onboarding-entry.mjs';
captureOnboardingEntry(location,history);
const adminQuery = new URLSearchParams(location.search);
// Host administration has its own lazily loaded composition root; the ordinary
// console never imports it.
if (location.pathname === '/console' && (adminQuery.has('boot') || adminQuery.has('admin'))) {
  await import('./admin-entry.mjs');
} else if (new URLSearchParams(location.search).get('demo') === '1' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
  await import('./demo-main.mjs');
} else {
  await import('./release.mjs');
}

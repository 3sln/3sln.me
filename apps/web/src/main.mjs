import {captureOnboardingEntry} from './providers/onboarding-entry.mjs';
captureOnboardingEntry(location,history);
if (new URLSearchParams(location.search).get('demo') === '1' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
  await import('./demo-main.mjs');
} else {
  await import('./release.mjs');
}

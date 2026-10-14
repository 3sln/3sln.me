// Capture before the dynamic application import. Never put this capability in
// Query state, browser storage, a navigation URL, or a third-party request.
let captured;
export function captureOnboardingEntry(location,history){
 if(location.pathname!=='/token-onboarding')return;
 const params=new URLSearchParams(location.hash.slice(1));
 const value=params.getAll('token');
 captured=value.length===1&&params.size===1&&typeof value[0]==='string'&&value[0].length<=32768&&/^bo1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value[0])?value[0]:null;
 const query=new URLSearchParams(location.search),locale=query.getAll('lang');
 history.replaceState(null,'',location.pathname+(locale.length===1&&['en','es'].includes(locale[0])?'?lang='+locale[0]:''));
}
export function takeOnboardingEntry(){const value=captured;captured=undefined;return value;}

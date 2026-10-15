const demoStyles=document.createElement('link');demoStyles.rel='stylesheet';demoStyles.href='/demo.css';document.head.append(demoStyles);
import { Engine, Provider, dodo } from './shared/stack.mjs';
import { Account, ChangeAccount } from './bl/account.mjs';
import accountApp from './ui/account-app.mjs';
import { defineBindleElements } from '/packages/sdk/src/elements/index.mjs';
defineBindleElements();
const api = {
  async get() { const response=await fetch('/api/demo'); if(!response.ok)throw new Error('Could not load demo account.');return response.json(); },
  async post(path,body) {const response=await fetch(`/api/demo/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok)throw new Error(result.message??result.error?.message??result.error??'Request failed.');return result;}
};
const engine=new Engine({providers:{api:Provider.fromSingleton(api)}});
const root=document.getElementById('app');
const subscription=engine.query(new Account()).subscribe({next:state=>dodo.reconcile(root,[accountApp(state)]),error:error=>dodo.reconcile(root,[accountApp({error:error.message})])});
let pending=false;
root.addEventListener('account-request',async event=>{
  const status=document.getElementById('consent-status');
  const {kind,...detail}=event.detail;
  if(kind==='decline'){status.textContent='Request declined. No access was granted.';return;}
  if(pending)return;
  if(kind==='consent'&&(!detail.acknowledged||detail.resources.length===0)){status.textContent='Choose at least one resource and confirm the allowed operations.';return;}
  pending=true;
  if(status)status.textContent=kind==='consent'?'Granting selected access…':'Revoking access…';
  try {
    if(kind==='consent') {
      // Preference updates are a separate operation. The preview does not mutate shared settings implicitly.
      await engine.dispatch(new ChangeAccount('consent',{client:'https://myunifieddrive.example',methods:['get','put','delete'],...detail})).next('complete');
    }else if(kind==='preferences')await engine.dispatch(new ChangeAccount('preferences',detail)).next('complete');
    else if(kind==='revoke')await engine.dispatch(new ChangeAccount('revoke',detail)).next('complete');
      await new Promise(resolve=>setTimeout(resolve,0));
    const latestStatus=document.getElementById('consent-status');
    if(latestStatus)latestStatus.textContent=kind==='consent'?'Access granted for the selected storage. Review or revoke it below.':kind==='preferences'?'Storage preferences saved. No new app access was granted.':'Access revoked. Future calls are blocked.';
  }catch(error){if(status)status.textContent=error.message??'The request failed. No success has been confirmed.';}
  finally{pending=false;}
});
root.addEventListener('bindle-sign-in-request',event=>{
  document.getElementById('login-status').textContent=`Identity: ${event.detail.handle}. Live sign-in is not enabled in this preview.`;
});
window.addEventListener('pagehide',()=>{subscription.unsubscribe();engine.dispose();},{once:true});

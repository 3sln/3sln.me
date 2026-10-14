import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://space.example/token-onboarding'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element','FormData'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
for(const name of names)globalThis[name]=window[name];
const {Engine,Provider}=await import('../../apps/web/src/shared/stack.mjs');
const {default:StateProvider}=await import('../../apps/web/src/providers/browser-state.mjs');
const {SignUp,SignupNext}=await import('../../apps/web/src/bl/release.mjs');
test.after(async()=>{await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});

async function fixture(step='credential'){
 const secrets={onboardingToken:'bo1.e30.'+'A'.repeat(43)},calls=[],navigation=[];
 let resolve,reject;
 const wait=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const browser={id:()=>crypto.randomUUID(),now:()=>Date.now(),secret:key=>secrets[key],storeSecret:(key,value)=>secrets[key]=value,savePending:value=>{secrets.pending=value;secrets.onboardingToken=null;},saveSetupChoice(){},captcha:()=>({turnstileToken:'fixture'}),resetCaptcha(){},navigate:value=>navigation.push(value),cancelDeviceEntry(){}};
 const api={csrf:'current-owner-csrf',async request(path,body){calls.push({path,body});return wait;},async get(){throw Error('Unexpected GET');}};
 const engine=new Engine({providers:{state:StateProvider,api:Provider.fromSingleton(api),browser:Provider.fromSingleton(browser),portalContributions:Provider.fromSingleton({}),recoveryFile:Provider.fromSingleton({})}});
 const write=patch=>engine.container.use({state:{write:true}},({state})=>state.transition(s=>Object.assign(s,patch)));
 await write({loading:false,auth:'signup',authMethod:'password',signupMode:'onboarding',signupStep:step,signupTermsAccepted:true,onboardingName:'alice',onboardingNames:[{name:'alice',status:'available'}],beamGeneration:1,config:{origin:'https://space.example',signupEnabled:false,tokenOnboardingEnabled:true,localDevelopment:true,signupContactRequired:false},route:{kind:'home'}});
 return {secrets,calls,navigation,browser,api,write,resolve,reject,read:()=>engine.container.use(['state'],({state})=>state.snapshot()),act:action=>engine.dispatch(action).next('complete'),close:()=>engine.dispose()};
}
async function started(f){for(let n=0;n<100&&!f.calls.length;n++)await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.calls.length,1);}

test('late invitation claim cannot install pending authority after cancellation or another owner signs in',async()=>{
 const f=await fixture();try{
  const operation=f.act(new SignUp({values:{password:'a private fixture password'}}));await started(f);
  f.secrets.onboardingToken=null;
  await f.write({auth:'login',signupMode:'ordinary',beamGeneration:2,session:{account:{id:'new-owner',handle:'n.new'}},error:''});
  f.resolve({pendingToken:'old-limited-authority',account:{handle:'n.old',status:'pending'},readyForRecovery:true});await operation;
  assert.equal(f.secrets.pending,undefined);assert.equal((await f.read()).pending,false);assert.equal((await f.read()).session.account.id,'new-owner');assert.deepEqual(f.navigation,[]);
 }finally{await f.close();}
});

test('late failed invitation request cannot log out a newly selected account',async()=>{
 const f=await fixture();try{
  const operation=f.act(new SignUp({values:{password:'a private fixture password'}}));await started(f);
  f.secrets.onboardingToken=null;await f.write({auth:'login',signupMode:'ordinary',beamGeneration:2,session:{account:{id:'new-owner',handle:'n.new'}},error:''});
  f.reject(Object.assign(Error('Expired old invitation'),{status:401,code:'invalid_onboarding_invitation'}));await operation;
  assert.equal((await f.read()).session?.account?.id,'new-owner');assert.equal(f.api.csrf,'current-owner-csrf');assert.equal((await f.read()).error,'');
 }finally{await f.close();}
});

test('cancelled invitation begin does not send its secret in a subsequent inspection',async()=>{
 const f=await fixture('onboarding');try{
  const operation=f.act(new SignupNext({values:{}}));await started(f);
  f.secrets.onboardingToken=null;await f.write({auth:'login',signupMode:'ordinary',beamGeneration:2});
  f.resolve({ready:true});await operation;
  assert.deepEqual(f.calls.map(call=>call.path),['/api/auth/onboarding/begin']);
 }finally{await f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const window=new Window({url:'https://provider.example/console'});
const names=['document','HTMLElement','CustomEvent','Event','EventTarget','Node','Element'];
const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
for(const name of names)globalThis[name]=window[name];
const {dodo}=await import('../../apps/web/src/shared/stack.mjs');
const {default:localize}=await import('../../apps/web/src/ui/localize.mjs');
const {createLocalization}=await import('../../packages/i18n/index.mjs');
const {messageOutcomeView,messageActionDialog}=await import('../../apps/web/src/ui/message-actions.mjs');
test.after(async()=>{await window.happyDOM.close();for(const name of names)globalThis[name]=previous[name];});
const mount=(node,locale='en')=>{const root=document.createElement('main');dodo.reconcile(root,[localize(node,createLocalization({locale}))]);return root;};
const outcome=(value,locale='en')=>mount(messageOutcomeView({messageOutcome:value}),locale);
const dialog=(review,{locale='en',available=true,actionKind='form',busy=false}={})=>mount(messageActionDialog({modal:{kind:'message-action',id:'private-review-reference',actionKind,available},messageActionReview:review,busy}).body,locale);
const assertIsolatedLink=link=>{assert.equal(link.target,'_blank');assert(link.relList.contains('noopener'));assert(link.relList.contains('noreferrer'));assert.equal(link.referrerPolicy,'no-referrer');};

test('typed result links are bounded, literal through Bab, visibly identify destination and isolate new tabs',()=>{
 const label='<img src="https://tracker.example/pixel" onerror="alert(1)"> Save changes';
 const toast={type:'info',message:'<script>untrusted()</script> Save changes',actions:[{label,href:'https://help.example/answer?ticket=opaque'},{label:'Save changes',href:'https://another.example/help'},{label:'Must not render',href:'https://third.example/'}]};
 for(const locale of ['en','es']){
  const root=outcome({type:'status',toast},locale),links=[...root.querySelectorAll('a')];assert.equal(links.length,2);
  assert.equal(root.querySelector('script,img,iframe,style'),null);assert(root.textContent.includes(toast.message));assert.equal(links[0].querySelector('span').textContent,label);assert.equal(links[1].querySelector('span').textContent,'Save changes');assert(!root.textContent.includes('Must not render'));
  for(const [i,link]of links.entries()){assertIsolatedLink(link);assert.equal(link.href,toast.actions[i].href);assert.equal(link.title,toast.actions[i].href);assert.equal(link.querySelector('bdi').textContent,new URL(link.href).origin);assert.equal(link.querySelector('bdi').dir,'ltr');}
 }
});

test('typed toast and redirect links refuse unsafe schemes, URL credentials and raw control/space normalization',()=>{
 const unsafe=['javascript:alert(1)','data:text/html,<script>alert(1)</script>','http://app.example/','//app.example/path','https://user:password@app.example/','https://app.example@evil.example/','https://app.example/\npath',' https://app.example/path','https://app.example/a b','https://app.example/'+ 'a'.repeat(2048)];
 for(const href of unsafe){
  const typed=outcome({type:'status',toast:{type:'info',message:'Result',actions:[{label:'Open',href}]}});assert.equal(Boolean(typed.querySelector('a')),false,`Unsafe toast link: ${JSON.stringify(href)}`);
  const redirected=outcome({type:'redirect',location:href});assert.equal(Boolean(redirected.querySelector('a')),false,`Unsafe redirect: ${JSON.stringify(href)}`);
 }
});

test('server-classified HTTP error stays an alert rather than a successful submission announcement',()=>{
 const error=outcome({type:'status',toast:{type:'error',message:'Payment refused',actions:[{label:'Help',href:'https://help.example/'}]}});
 assert(error.querySelector('section').classList.contains('submission-error'));assert(!error.querySelector('section').classList.contains('submission-success'));assert.equal(error.querySelector('section').getAttribute('role'),'alert');assert.equal(error.querySelector('p').textContent,'Payment refused');assertIsolatedLink(error.querySelector('a'));
 const unknown=outcome({type:'unknown'});assert(unknown.querySelector('section').classList.contains('submission-warning'));assert.equal(unknown.querySelector('section').getAttribute('role'),'status');assert.match(unknown.textContent,/will not be sent again/);assert.equal(unknown.querySelector('a'),null);
});

test('redirect result exposes actual destination separately from any author label and never becomes a native form',()=>{
 const location='https://different-app.example/result?receipt=opaque',root=outcome({type:'redirect',location});const link=root.querySelector('a');assertIsolatedLink(link);assert.equal(link.href,location);assert.equal(link.title,location);assert.equal(link.querySelector('bdi').textContent,'https://different-app.example');assert.equal(root.querySelector('form,iframe'),null);
});

test('form review shows the full exact destination and literal field values, with no native submission surface',()=>{
 const review={url:'https://app.example/submit?purpose=confirm',fields:[['<b>field</b>','<img src="https://tracker.example/">'],['Save changes','Save changes']]};
 for(const locale of ['en','es']){
  const root=dialog(review,{locale});assert.equal(root.querySelector('bdi[dir=ltr]').textContent,review.url);assert.equal(root.querySelector('script,img,iframe,form'),null);assert.deepEqual([...root.querySelectorAll('dt')].map(n=>n.textContent),review.fields.map(p=>p[0]));assert.deepEqual([...root.querySelectorAll('pre')].map(n=>n.textContent),review.fields.map(p=>p[1]));assert.equal(root.querySelector('button.primary').type,'button');assert.equal(root.querySelector('button.primary').disabled,false);
 }
 const busy=dialog(review,{busy:true});assert.equal(busy.querySelector('button.primary').disabled,true);
 const unavailable=dialog(review,{available:false});assert.equal(unavailable.querySelector('button.primary'),null);assert.equal(unavailable.querySelector('a,form'),null);assert(unavailable.querySelector('[role=status]'));
});

test('link review is explicit, isolated, and cannot render a substituted unsafe URL as navigation',()=>{
 const href='https://external.example/read?item=1',root=dialog({url:href,fields:[]},{actionKind:'link'}),link=root.querySelector('a');assertIsolatedLink(link);assert.equal(link.href,href);assert.equal(root.querySelector('bdi').textContent,href);
 for(const url of ['javascript:alert(1)','https://secret@external.example/','https://external.example/\npath'])assert.equal(Boolean(dialog({url,fields:[]},{actionKind:'link'}).querySelector('a')),false);
});

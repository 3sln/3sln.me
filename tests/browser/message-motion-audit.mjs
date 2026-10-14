import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,Provider} from '../../apps/web/src/shared/stack.mjs';
import StateProvider from '../../apps/web/src/providers/browser-state.mjs';
import {SetMessageAnimations} from '../../apps/web/src/bl/release.mjs';
import {MessageActions} from '../../apps/web/src/providers/message-actions.mjs';

const priorDocument=globalThis.document;globalThis.document={hidden:false};test.after(()=>{globalThis.document=priorDocument;});

// These tests cover trusted preference/episode policy. They do not substitute
// for the separate opaque-frame CSS and native browser motion regressions.
test('recipient can stop current motion even when browser preference storage refuses writes',async()=>{
 const engine=new Engine({providers:{state:StateProvider,browser:Provider.fromSingleton({savePreferences(){throw Error('Storage unavailable');}})}});let state;
 try{await engine.container.use({state:{write:true}},({state:resource})=>{state=resource;resource.transition(next=>Object.assign(next,{messageAnimations:true,locale:'en'}));});await engine.dispatch(new SetMessageAnimations({enabled:false})).next('complete');assert.equal(state.snapshot().messageAnimations,false);assert(state.snapshot().error,'Persistence failure remains visible');}finally{await engine.dispose();}
});

function episodeFixture(){
 const state={session:{account:{id:'owner-a'}},beamGeneration:1,selected:'message-a',messageDetail:{id:'message-a'},messageRender:{source:{mimeType:'text/html',text:'Message',digest:'source-a'},presentation:{revision:0}},route:{},messageAnimations:true};
 const controller=new MessageActions(),frame={},dispose=()=>{};dispose.setMotion=()=>{};controller.read=()=>state;controller.root={querySelector:()=>frame};controller.reducedMotion={matches:false};const sync=controller.sync.bind(controller);controller.sync=()=>{controller.active={frame,key:controller.key(controller.context()),dispose};sync();};controller.sync();return {state,controller,episode:()=>[...controller.motionEpisodes.values()][0]};
}

test('same displayed content keeps its exhausted allowance across history-only changes and reconnect authority generations',()=>{
 const f=episodeFixture(),first=f.episode();first.deadline=Date.now()-1;f.controller.sync();assert.equal(first.stopped,true);
 f.state.messageRender.presentation.revision=9;f.controller.sync();assert.equal(f.episode(),first,'A retained status does not create new presented content');
 f.state.beamGeneration++;f.controller.sync();assert.equal(f.episode(),first,'Reconnect fencing does not replenish the display budget');assert.equal(f.episode().stopped,true);
});

test('reduced-motion and explicit disable stop an episode without re-enabling it through a preference toggle',()=>{
 const f=episodeFixture();f.controller.reducedMotion.matches=true;f.controller.sync();const first=f.episode();assert.equal(first.stopped,true);
 f.controller.reducedMotion.matches=false;f.state.messageAnimations=true;f.controller.sync();assert.equal(f.episode(),first);assert.equal(first.stopped,true);
 f.state.session.account.id='owner-b';f.controller.sync();assert.notEqual(f.episode(),first,'Another owner has independent policy state');assert.equal(f.controller.motionEpisodes.size,1);
 f.state.messageAnimations=false;f.controller.sync();assert.equal(f.episode().stopped,true);
});

test('hiding an active display freezes its episode and becoming visible cannot renew it',()=>{
 const f=episodeFixture(),first=f.episode();assert.equal(first.stopped,false);
 try{document.hidden=true;f.controller.sync();assert.equal(first.stopped,true);document.hidden=false;f.controller.sync();assert.equal(f.episode(),first);assert.equal(first.stopped,true);}finally{document.hidden=false;}
});

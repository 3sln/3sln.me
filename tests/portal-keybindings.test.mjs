import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWhen,compileKeybindings,normalizeKeyStroke,resolveKeybinding,inspectKeybindings,portalContext} from '../packages/portal/keybindings.mjs';
const context={view:'inbox',dialogOpen:false,textInputFocus:false,selectionCount:1,authenticated:true,offline:false};
const commands=['open','close','delete','other'];
test('when language handles precedence, equality, negation and refuses unknown keys/code',()=>{
 assert.equal(compileWhen('view == "inbox" && !dialogOpen && (authenticated || offline)').matches(context),true);
 assert.equal(compileWhen('selectionCount == 0 || offline').matches(context),false);
 for(const source of ['window.alert(1)','view.constructor','view == evil()','unknown','view == "inbox"; true','!'.repeat(30)+'offline'])assert.throws(()=>compileWhen(source));
 assert.throws(()=>compileWhen('x'.repeat(513)));
});
test('platform modifiers, chord sequence and timeout resolve deterministically',()=>{
 assert.equal(normalizeKeyStroke({key:'K',ctrlKey:true,shiftKey:true},'Linux'),'mod+shift+k');assert.equal(normalizeKeyStroke({key:'k',metaKey:true},'MacIntel'),'mod+k');assert.equal(normalizeKeyStroke({key:'k',isComposing:true},'Linux'),null);
 const bindings=compileKeybindings([{command:'open',key:'mod+k mod+c',when:'view == "inbox" && !textInputFocus'}],[],commands);
 const first=resolveKeybinding(bindings,context,null,'mod+k',{now:1});assert.equal(first.status,'chord');assert.equal(first.consumed,true);
 assert.equal(resolveKeybinding(bindings,context,first.sequence,'mod+c',{now:500}).command,'open');assert.equal(resolveKeybinding(bindings,context,first.sequence,'mod+c',{now:2000}).status,'none');
 assert.equal(resolveKeybinding(bindings,context,first.sequence,'x',{now:500}).consumed,false);
});
test('user override precedence, removal and conflict inspector identify the winner',()=>{
 const defaults=[{command:'open',key:'mod+k',when:'authenticated'},{command:'other',key:'mod+k',when:'view == "inbox" && authenticated'}];
 let bindings=compileKeybindings(defaults,[{command:'close',key:'mod+k',when:'authenticated'}],commands);
 assert.equal(resolveKeybinding(bindings,context,null,'mod+k').command,'close');assert.equal(inspectKeybindings(bindings,context)[0].winner,'close');assert.ok(inspectKeybindings(bindings,context)[0].conflicts.includes('open'));
 bindings=compileKeybindings(defaults,[{command:'-other'}],commands);assert.equal(resolveKeybinding(bindings,context,null,'mod+k').command,'open');
 assert.throws(()=>compileKeybindings(defaults,[{command:'missing',key:'mod+k'}],commands));assert.throws(()=>compileKeybindings(defaults,[{command:'open',key:'mod++k'}],commands));
});
test('typing, browser shortcuts, composition and dialog contexts stay guarded',()=>{
 const typing={...context,textInputFocus:true},defaults=[{command:'delete',key:'delete',when:'authenticated'},{command:'close',key:'escape',when:'dialogOpen && !textInputFocus'},{command:'open',key:'mod+l'}];
 let bindings=compileKeybindings(defaults,[],commands);
 assert.equal(resolveKeybinding(bindings,typing,null,'delete').consumed,false);assert.equal(resolveKeybinding(bindings,context,null,'mod+l').consumed,false);assert.equal(resolveKeybinding(bindings,context,null,'escape').consumed,false);assert.equal(resolveKeybinding(bindings,{...context,dialogOpen:true},null,'escape').command,'close');
 bindings=compileKeybindings([],[{command:'open',key:'mod+k',when:'textInputFocus && authenticated'}],commands);assert.equal(resolveKeybinding(bindings,typing,null,'mod+k').command,'open');assert.equal(normalizeKeyStroke({key:'x',defaultPrevented:true}),null);
 assert.deepEqual(portalContext({view:'inbox',modal:{},session:{account:{}},selected:'id',offline:true},{textInputFocus:true}),{...typing,dialogOpen:true,offline:true,authenticated:false});
});

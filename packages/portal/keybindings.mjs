// A bounded declarative language: no eval, Function, property access or calls.
export const contextKeys=Object.freeze(['view','dialogOpen','textInputFocus','selectionCount','authenticated','offline']);
export function compileWhen(source=''){
 if(typeof source!=='string'||source.length>512)throw new TypeError('A when clause must be at most 512 characters.');
 if(!source.trim())return Object.freeze({matches:()=>true,keys:Object.freeze([]),specificity:0,source:''});
 const tokens=[],pattern=/\s*(===|!==|==|!=|&&|\|\||[!()]|"[^"\\\r\n]*"|'[^'\\\r\n]*'|\d+|[A-Za-z][A-Za-z0-9]*)/y;
 let offset=0;while(offset<source.length){if(!source.slice(offset).trim())break;pattern.lastIndex=offset;const match=pattern.exec(source);if(!match)throw new SyntaxError('Invalid when clause.');tokens.push(match[1]);offset=pattern.lastIndex;if(tokens.length>96)throw new SyntaxError('When clause is too complex.');}
 let position=0,depth=0,specificity=0;const keys=new Set(),take=()=>tokens[position++],peek=()=>tokens[position];
 function literal(){const token=take();if(token==='true'||token==='false')return token==='true';if(/^\d+$/.test(token??''))return Number(token);if(token?.startsWith('"')||token?.startsWith("'"))return token.slice(1,-1);throw new SyntaxError('Expected a literal in when clause.');}
 function atom(){if(++depth>24)throw new SyntaxError('When clause is too deeply nested.');let node;if(peek()==='!'){take();node={op:'!',value:atom()};}else if(peek()==='('){take();node=or();if(take()!==')')throw new SyntaxError('Unclosed when clause.');}else{const key=take();if(!contextKeys.includes(key))throw new SyntaxError(`Unknown context key: ${key}`);keys.add(key);specificity++;node={op:'key',key};if(['==','!=','===','!=='].includes(peek()))node={op:take(),key,value:literal()};}depth--;return node;}
 function and(){let node=atom();while(peek()==='&&'){take();node={op:'&&',left:node,right:atom()};}return node;}
 function or(){let node=and();while(peek()==='||'){take();node={op:'||',left:node,right:and()};}return node;}
 const ast=or();if(position!==tokens.length)throw new SyntaxError('Unexpected token in when clause.');
 function evaluate(node,context){switch(node.op){case 'key':return Boolean(context[node.key]);case '!':return !evaluate(node.value,context);case '&&':return evaluate(node.left,context)&&evaluate(node.right,context);case '||':return evaluate(node.left,context)||evaluate(node.right,context);case '==':case '===':return context[node.key]===node.value;case '!=':case '!==':return context[node.key]!==node.value;}}
 return Object.freeze({matches:context=>evaluate(ast,context),keys:Object.freeze([...keys]),specificity,source});
}
const modifiers=['mod','ctrl','meta','alt','shift'];
export function normalizeBindingKey(key){
 if(typeof key!=='string'||key.length>100)throw new TypeError('A keybinding needs a bounded key sequence.');
 const strokes=key.trim().toLowerCase().split(/\s+/);if(!key.trim()||strokes.length>3)throw new TypeError('A keybinding needs one to three strokes.');
 return strokes.map(stroke=>{const parts=stroke.split('+'),main=parts.pop();if(!main||!/^([a-z0-9]|f(?:[1-9]|1[0-2])|escape|enter|space|tab|backspace|delete|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|\/|\.|,|;|\[|\]|-|=)$/.test(main)||parts.some(part=>!modifiers.includes(part))||new Set(parts).size!==parts.length)throw new TypeError(`Invalid key stroke: ${stroke}`);return [...modifiers.filter(modifier=>parts.includes(modifier)),main].join('+');});
}
export function normalizeKeyStroke(event,platform=''){
 if(event.isComposing||event.defaultPrevented||['Dead','Unidentified','Process','Control','Shift','Alt','Meta'].includes(event.key))return null;
 const apple=/Mac|iPhone|iPad/i.test(platform),parts=[];
 if(apple?event.metaKey:event.ctrlKey)parts.push('mod');
 if(apple&&event.ctrlKey)parts.push('ctrl');if(!apple&&event.metaKey)parts.push('meta');if(event.altKey)parts.push('alt');if(event.shiftKey)parts.push('shift');
 parts.push(event.key===' '?'space':String(event.key).toLowerCase());
 try{return normalizeBindingKey(parts.join('+'))[0];}catch{return null;}
}
export function compileKeybindings(defaults=[],overrides=[],commands=[]){
 if(!Array.isArray(defaults)||!Array.isArray(overrides)||overrides.length>128)throw new TypeError('Keybindings must be arrays of at most 128 overrides.');
 const known=new Set(commands.map(command=>typeof command==='string'?command:command.id));
 const bind=(binding,user,index)=>{if(!binding||typeof binding.command!=='string'||!known.has(binding.command))throw new TypeError(`Unknown shortcut command: ${binding?.command}`);if(Object.keys(binding).some(key=>!['command','key','when'].includes(key)))throw new TypeError('Unknown keybinding field.');const strokes=normalizeBindingKey(binding.key),condition=compileWhen(binding.when??'');return Object.freeze({...binding,key:strokes.join(' '),when:binding.when??'',strokes:Object.freeze(strokes),condition,user,index});};
 let result=defaults.map((binding,index)=>bind(binding,false,index));
 for(const [index,binding] of overrides.entries()){
  if(binding?.command?.startsWith('-')){const id=binding.command.slice(1);if(!known.has(id))throw new TypeError(`Unknown shortcut command: ${id}`);if(Object.keys(binding).some(key=>!['command','key','when'].includes(key)))throw new TypeError('Unknown keybinding field.');const key=binding.key===undefined?undefined:normalizeBindingKey(binding.key).join(' ');if(binding.when!==undefined)compileWhen(binding.when);result=result.filter(item=>item.command!==id || key!==undefined&&item.key!==key || binding.when!==undefined&&item.when!==binding.when);}
  else result.push(bind(binding,true,index));
 }
 // User entries win; among equal origin, a narrower context wins, then the
 // later declaration. Conflict inspection exposes the winner to settings UI.
 result.sort((a,b)=>Number(b.user)-Number(a.user)||b.condition.specificity-a.condition.specificity||b.index-a.index||a.command.localeCompare(b.command,'en'));
 return Object.freeze(result);
}
const samePrefix=(strokes,sequence)=>sequence.every((stroke,index)=>strokes[index]===stroke);
const browserKeys=new Set(['mod+l','mod+r','mod+w','mod+t','mod+n','mod+q','mod+shift+t','mod+shift+r','mod+p','mod+f','mod+g','mod+k','mod+0','mod+-','mod+=','mod+shift+=','tab','shift+tab','f5']);
function eligible(binding,context){return binding.condition.matches(context)&&(!context.textInputFocus||binding.condition.keys.includes('textInputFocus'))&&(!browserKeys.has(binding.strokes[0])||binding.when.trim().length>0);}
export function resolveKeybinding(bindings,context,sequence,stroke,{now=Date.now(),timeout=1500}={}){
 if(!stroke)return Object.freeze({status:'none',consumed:false,sequence:Object.freeze([])});
 const prior=sequence?.strokes && now-sequence.startedAt<=timeout?sequence.strokes:[];
 let strokes=[...prior,stroke],candidates=bindings.filter(binding=>eligible(binding,context)&&samePrefix(binding.strokes,strokes));
 if(!candidates.length&&prior.length){strokes=[stroke];candidates=bindings.filter(binding=>eligible(binding,context)&&samePrefix(binding.strokes,strokes));}
 if(!candidates.length)return Object.freeze({status:'none',consumed:false,sequence:Object.freeze([])});
 const winner=candidates[0];
 if(winner.strokes.length===strokes.length)return Object.freeze({status:'command',command:winner.command,consumed:true,sequence:Object.freeze([])});
 return Object.freeze({status:'chord',consumed:true,sequence:Object.freeze({strokes:Object.freeze(strokes),startedAt:prior.length?sequence.startedAt:now})});
}
export function inspectKeybindings(bindings,context={}){return Object.freeze(bindings.map(binding=>{const peers=bindings.filter(other=>other.key===binding.key&&eligible(other,context));return Object.freeze({command:binding.command,key:binding.key,when:binding.when,user:binding.user,active:eligible(binding,context),conflicts:Object.freeze(peers.filter(peer=>peer!==binding).map(peer=>peer.command)),winner:peers[0]?.command});}));}
export function portalContext(state,focus={}){return Object.freeze({view:String(state.view??''),dialogOpen:!!state.modal,textInputFocus:!!focus.textInputFocus,selectionCount:state.selected?1:0,authenticated:!!state.session?.account&&!state.offline,offline:!!state.offline});}

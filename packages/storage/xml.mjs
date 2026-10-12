import { StorageError } from './policy.mjs';
const invalid=()=>{throw new StorageError('invalid_xml','Provider XML is malformed or unsafe.',502);};
const entities=text=>text.replace(/&([^;]*);/g,(_,entity)=>{const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(known,entity))return known[entity];if(!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity))invalid();const number=entity[1]==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));if(!number||number>0x10ffff||(number>=0xd800&&number<=0xdfff))invalid();return String.fromCodePoint(number);});
// Small fail-closed XML subset for bounded provider listings. No DTD/entity
// declarations, fetching, expansion, processing instructions or mixed markup.
export function parseXML(text){
  if(typeof text!=='string'||text.length>1048576||/<!DOCTYPE|<!ENTITY/i.test(text))invalid();
  text=text.replace(/^\s*<\?xml\s[^?]*\?>/,'');
  const root={name:'#document',children:[],text:''};const stack=[root];let offset=0,count=0;
  const token=/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;let match;
  while((match=token.exec(text))){if(match.index!==offset||++count>20000)invalid();offset=token.lastIndex;const value=match[0];const parent=stack.at(-1);
    if(value.startsWith('<!--'))continue;
    if(value.startsWith('<![CDATA[')){parent.text+=value.slice(9,-3);continue;}
    if(value.startsWith('</')){const end=/^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(value);if(!end||stack.length===1||parent.qualified!==end[1])invalid();stack.pop();continue;}
    if(value.startsWith('<')){const start=/^<([A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*(\/?)>$/.exec(value);if(!start||stack.length>32)invalid();const node={name:start[1].split(':').at(-1),qualified:start[1],children:[],text:''};parent.children.push(node);if(!start[2])stack.push(node);continue;}
    if(/&(?![^&;]+;)/.test(value))invalid();parent.text+=entities(value);
  }
  if(offset!==text.length||stack.length!==1||root.children.length!==1||root.text.trim())invalid();return root.children[0];
}
export const children=(node,name)=>node.children.filter(child=>child.name===name);
export const child=(node,name)=>children(node,name)[0];
export const value=(node,name)=>child(node,name)?.text||'';

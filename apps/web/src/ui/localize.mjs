import {InterfaceText} from './interface-text.mjs';
import {dodo} from '../shared/stack.mjs';
// Localize newly constructed interface nodes. translate="no" marks owner data,
// message titles and bodies, URLs, and other content that must never be changed.
// Reconstruction uses dodo's actual chained node API; no state is modified.
export default function localizeTree(node,{t}){
  if(node instanceof InterfaceText)return t(node.source,node.variables);
  if(typeof node==='string')return t(node);
  if(Array.isArray(node))return node.map(child=>localizeTree(child,{t}));
  if(!node||typeof node!=='object'||typeof node.tag!=='string'||node.$?.attrs?.translate==='no')return node;
  const result=dodo.h(node.tag,...node.args.map(child=>localizeTree(child,{t})));
  const properties={...node.p};for(const key of ['title','alt','placeholder'])if(typeof properties[key]==='string')properties[key]=t(properties[key]);
  const attributes={...node.$?.attrs};for(const key of ['aria-label'])if(typeof attributes[key]==='string')attributes[key]=t(attributes[key]);
  return result.props(properties).attrs(attributes).classes(...(node.$?.classes??[])).style(node.$?.styling).data(node.$?.dataset).on(node.hooks).key(node.k);
}

export const CONTACT_PROFILE_MIME='application/vnd.bindle.contact-profile+json';
const representations=['text/html',CONTACT_PROFILE_MIME,'application/json','application/vnd.bindle.contact-token+jwt'];
// A specific q=0 vetoes a wider wildcard. Equal-quality defaults prefer HTML.
export function selectContactRepresentation(accept='*/*'){
 if(typeof accept!=='string'||accept.length>4096)return null;
 const ranges=accept.split(',').map(piece=>{const [raw,...parameters]=piece.trim().toLowerCase().split(';'),type=raw.trim();let q=1;for(const parameter of parameters){const [key,value]=parameter.trim().split('=');if(key==='q')q=value!==undefined&&/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?|\.\d{1,3})$/.test(value.trim())?Number(value.trim()):0;}return {type,q};});
 let chosen=null,quality=0;for(const representation of representations){const top=representation.split('/')[0],matching=ranges.filter(r=>r.type===representation||r.type===`${top}/*`||r.type==='*/*').map(r=>({...r,specificity:r.type===representation?2:r.type==='*/*'?0:1}));if(!matching.length)continue;const specificity=Math.max(...matching.map(r=>r.specificity)),q=Math.max(...matching.filter(r=>r.specificity===specificity).map(r=>r.q));if(q>quality){quality=q;chosen=representation;}}return chosen;
}

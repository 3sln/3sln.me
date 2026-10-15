// Monogram pattern (components profile Appendix A), shared by the elements and the island bundle through
// islands-protocol.mjs. Kept separate so the elements' first render can re-export it without the protocol module.
// Dependency-free, side-effect free.
function fnv(text,seed=0x811c9dc5){let hash=seed>>>0;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}return hash>>>0;}
/** 5×5 symmetric cells (row-major) from 15 bits of `a`; colour index from `b`. Null for an unusable subject. */
export function monogramPattern(subject){
  if(typeof subject!=='string'||!subject||subject.length>2048)return null;
  const a=fnv(subject),b=fnv(subject,(a^0x9e3779b9)>>>0),cells=[];
  for(let r=0;r<5;r++)for(let c=0;c<5;c++)cells.push(((a>>>(r*3+(c<3?c:4-c)))&1)===1);
  if(!cells.some(Boolean))cells[12]=true;
  const index=b%24;return Object.freeze({cells:Object.freeze(cells),index,hue:index*15+7.5});
}

// Initials for the standard avatar (components-profile decision note §7). Pure,
// no DOM, no network. Returns 0–2 grapheme clusters; '' means "use the monogram".
// Coordinator decision: one letter for single-word names, two (first word, last word) otherwise.
const ignorable=/[\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;
const emoji=/^(?:\p{RI}\p{RI}|[#*0-9]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic})/u;
const leadingJunk=/^[\p{Z}\p{P}\s]+/u;
// Fallback cluster matcher (no Intl.Segmenter): RI pair, or a base with marks, modifiers, VS16, tags and ZWJ sequences.
const clusterPattern=/^(?:\p{RI}\p{RI}|\P{M}[\p{M}\p{EMod}\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}]*(?:\u{200D}\P{M}[\p{M}\p{EMod}\u{FE0F}]*)*)/u;
const single=/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}\p{sc=Yi}\p{sc=Bopomofo}\p{sc=Arabic}\p{sc=Syriac}\p{sc=Nko}\p{sc=Mongolian}\p{sc=Adlam}]/u;
const cased=/^[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}\p{sc=Armenian}]/u;
const rtl=/^[\p{sc=Hebrew}\p{sc=Arabic}\p{sc=Syriac}\p{sc=Thaana}\p{sc=Nko}\p{sc=Adlam}\p{sc=Samaritan}\p{sc=Mandaic}]/u;
const Segmenter=globalThis.Intl?.Segmenter;
const graphemeSegmenter=Segmenter&&new Segmenter(undefined,{granularity:'grapheme'});
const wordSegmenter=Segmenter&&new Segmenter(undefined,{granularity:'word'});

function graphemes(text){
  if(graphemeSegmenter)return [...graphemeSegmenter.segment(text)].map(part=>part.segment);
  const out=[];let rest=text;
  while(rest){const match=clusterPattern.exec(rest);const cluster=match?.[0]||String.fromCodePoint(rest.codePointAt(0));out.push(cluster);rest=rest.slice(cluster.length);}
  return out;
}
const words=text=>wordSegmenter?[...wordSegmenter.segment(text)].filter(part=>part.isWordLike).map(part=>part.segment):text.split(/[\p{Z}\p{P}]+/u).filter(Boolean);
// First letter or digit cluster of a word: marks capped at three, NFKC applied to that cluster only.
function firstCluster(word){
  const cluster=graphemes(word).find(item=>/^[\p{L}\p{N}]/u.test(item));if(!cluster)return '';
  let marks=0;const capped=[...cluster].filter(char=>!/\p{M}/u.test(char)||++marks<=3).join('');
  return graphemes(capped.normalize('NFKC'))[0]??'';
}
const direction=cluster=>rtl.test(cluster)?'rtl':/^\p{L}/u.test(cluster)?'ltr':null;
function upper(cluster){if(!cased.test(cluster))return cluster;const value=cluster.toUpperCase();return graphemes(value).length===1?value:cluster;}

function fromText(raw,{handle=false}={}){
  if(typeof raw!=='string')return '';
  let text=raw.normalize('NFC').replace(/\s+/gu,' ').trim();
  if(handle){const at=text.lastIndexOf('@');if(at>=0)text=text.slice(0,at);const plus=text.indexOf('+');if(plus>=0)text=text.slice(0,plus);}
  // Emoji first, before ignorable stripping (ZWJ, VS16 and tags are default-ignorable).
  const lead=text.replace(leadingJunk,'');
  if(lead){const first=graphemes(lead)[0];if(emoji.test(first))return first;}
  text=text.replace(ignorable,'');
  const list=(handle?text.split(/[._-]+/u):words(text)).map(firstCluster).filter(Boolean);
  if(!list.length)return '';
  const first=list[0];
  if(single.test(first)||list.length===1)return upper(first);
  const last=list.at(-1),a=direction(first),b=direction(last);
  if(a&&b&&a!==b)return upper(first);
  return upper(first)+upper(last);
}
export function initials(displayName,handle){return fromText(displayName)||fromText(handle,{handle:true});}

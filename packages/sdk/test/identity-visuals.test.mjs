// Identity visuals: initials (decision note §7), shared OKLCH tones (§7.1) and the
// standard avatar chain. Pure tests; no provider, no DOM.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initials} from '../src/elements/initials.mjs';
import {avatarModel,identityStyle} from '../src/elements/avatar-view.mjs';
import {monogramPattern as sharedPattern,oklchToHex,contrastRatio,monogramColors} from '../src/islands-protocol.mjs';
import {monogramPattern} from '../src/elements/monogram.mjs';

const clusters=text=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].length;

test('initials: Latin words, handles, case and the one/two letter rule',()=>{
  assert.equal(initials('Ada Lovelace'),'AL');
  assert.equal(initials('ada'),'A');
  assert.equal(initials('Ada Augusta King Lovelace'),'AL');
  assert.equal(initials(undefined,'ada.lovelace@self.example'),'AL');
  assert.equal(initials(undefined,'ada_lovelace+tag@self.example'),'AL');
  assert.equal(initials(undefined,'ada-l'),'AL');
  assert.equal(initials('','ada@x.example'),'A','an empty display name falls back to the handle');
  assert.equal(initials('Ada','zed@x.example'),'A','display name wins over the handle');
  assert.equal(initials('(ada) lovelace'),'AL');
  assert.equal(initials('3sln team'),'3T');
  assert.equal(initials('ﬁona'),'F');
  assert.equal(initials('ßeta'),'ß','no expansion to SS');
  const turkish=initials('ışık yılmaz');assert.equal(clusters(turkish),2);assert.equal(turkish,'IY');
  assert.equal(initials('ελένη παπαδοπούλου'),'ΕΠ');
});

test('initials: caseless, logographic, joining and mixed-direction names',()=>{
  assert.equal(initials('김민수'),'김');
  assert.equal(initials('山田太郎'),'山');
  assert.equal(initials('محمد علي'),'م');
  assert.equal(initials('שרה Smith'),'ש','differing strong directions keep only the first');
  const conjunct=initials('क्षत्रिय');assert.ok(conjunct.startsWith('क'));assert.equal(clusters(conjunct),1);
});

test('initials: emoji, flags, invisible characters and empty input',()=>{
  const family='\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal(initials(`${family} Family`),family);
  assert.equal(initials('\u{1F1EF}\u{1F1F5} Taro'),'\u{1F1EF}\u{1F1F5}');
  assert.equal(initials('​ada ㅤlovelace'),'AL');
  assert.equal(initials('ㅤ'),'');
  assert.equal(initials('   '),'');assert.equal(initials('',''),'');assert.equal(initials(),'');
  assert.equal(initials('!!! ???'),'');
});

test('identity tones: all 24 hues meet 4.5:1 in light and dark',()=>{
  const tones={light:[[0.93,0.03],[0.40,0.065]],dark:[[0.36,0.06],[0.93,0.03]]};
  for(let index=0;index<24;index++){
    const hue=index*15+7.5;
    for(const [scheme,[bg,fg]] of Object.entries(tones)){
      const ratio=contrastRatio(oklchToHex(...fg,hue),oklchToHex(...bg,hue));
      assert.ok(ratio>=4.5,`${scheme} hue ${index}: ${ratio.toFixed(2)}`);
    }
  }
});

test('monogram pattern and colours are shared with islands and stable',()=>{
  const subject='https://provider.example/people/ada';
  assert.equal(monogramPattern,sharedPattern);
  const pattern=monogramPattern(subject);assert.equal(pattern.cells.length,25);assert.deepEqual(pattern,monogramPattern(subject));
  for(let row=0;row<5;row++)for(let column=0;column<5;column++)assert.equal(pattern.cells[row*5+column],pattern.cells[row*5+4-column],'mirror symmetric');
  const style=identityStyle(subject);
  assert.equal(style['--_id-bg-l'],monogramColors(subject,'light').background);assert.equal(style['--_id-fg-d'],monogramColors(subject,'dark').foreground);
  assert.deepEqual(identityStyle(''),{});
});

test('avatar chain: picture, then initials, then monogram',()=>{
  const base={issuer:'https://provider.example',subject:'https://provider.example/u/1'};
  assert.deepEqual(avatarModel({...base,profile:{picture:'https://provider.example/p.png',displayName:'Ada Lovelace'}}),{source:'picture',subject:base.subject,picture:'https://provider.example/p.png'});
  assert.deepEqual(avatarModel({...base,profile:{picture:'https://provider.example/p.png',displayName:'Ada Lovelace'}},{pictureFailed:true}),{source:'initials',subject:base.subject,text:'AL'});
  assert.equal(avatarModel({...base,profile:{displayName:'Grace',handle:'ada@provider.example'}}).text,'G');
  assert.equal(avatarModel({...base,profile:{handle:'ada.l@provider.example'}}).text,'AL');
  assert.deepEqual(avatarModel(base),{source:'monogram',subject:base.subject});
  assert.ok(Object.isFrozen(avatarModel(base)));
});

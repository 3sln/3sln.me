// #account-switcher (profile §6, embed-islands §8, §13.1, §14). Constant shape in every state: one current-account
// card control, a list with exactly 8 row nodes plus the always-present "More at <host>" row as a single Tab stop
// (roving tabindex, wrapping arrows that never report an edge), and the fixed action buttons chosen by props.
// Nine tiles are re-rendered and swapped on every update whatever the binding count. Names the provider host and
// says the app cannot see the list (fixed palette). `select` goes out only for a binding whose flow delivered a
// code to this client (checked in the worker); "Manage"/"More" open a noopener provider tab and send `dismiss`.
import {h,defined} from './dom.mjs';
export const ROWS=8;
export function accountSwitcherPart({model,t,host,arming,worker,send,swap,nextTicket,startFlow,openProvider,refresh,doc=globalThis.document,win=globalThis.window}){
  let started=false,focusIndex=0;
  const current=()=>model.views.find(v=>model.subject&&v.subject===model.subject)??null;
  // session{subject:null} hides all account data immediately (embed-islands §4.3; IMPL-3).
  const others=()=>model.subject?model.views.filter(v=>v.subject&&v.subject!==model.subject).slice(0,ROWS):[];
  const update=async()=>{if(!started)return;const rows=others(),token=nextTicket();try{const client=await worker();await swap(await client.call('render',{subjects:[model.subject,...Array.from({length:ROWS},(_,i)=>rows[i]?.subject??null)],bucket:model.bucket}),token);}catch{}};
  const provider=()=>{openProvider();send({v:1,type:'dismiss'});};
  const select=async subject=>{try{if(await(await worker()).call('selectable',{subject}))send({v:1,type:'select',subject});}catch{}};
  const remove=async()=>{const subject=current()?.subject;model.confirm=false;refresh();if(!subject)return;try{await(await worker()).call('remove',{subject});}catch{}};
  const actions=()=>model.props.actions??['use-another','manage','remove'];
  function focusRow(index){const rows=[...doc.querySelectorAll('.list [data-row]:not([data-empty])')];if(!rows.length)return;focusIndex=(index+rows.length)%rows.length;refresh();rows[focusIndex]?.focus({preventScroll:true});}
  function onListKey(event){
    const rows=[...doc.querySelectorAll('.list [data-row]:not([data-empty])')],index=Math.max(0,rows.indexOf(doc.activeElement));
    const moves={ArrowDown:index+1,ArrowUp:index-1,Home:0,End:rows.length-1};if(!(event.key in moves))return;event.preventDefault();focusRow(moves[event.key]);
  }
  const row=(view,index,live)=>{
    const empty=!view,visibleIndex=live.indexOf(view);
    return h('li',h('button',h('img').classes('tile').attrs(defined({alt:'',src:model.tiles[index+1]??null})),h('span',h('bdi',view?.name??view?.handle??'').classes('name'),h('bdi',view&&view.name?view.handle:'').classes('handle')).classes('text'))
      .classes('row','control').attrs(defined({type:'button','data-row':String(index),'data-empty':empty?'':null,tabindex:empty?'-1':visibleIndex===focusIndex?'0':'-1','aria-hidden':empty?'true':null}))
      .on(empty?{}:arming.guard(()=>select(view.subject)))).attrs(defined({role:'listitem'}));
  };
  return Object.freeze({
    view(){
      const me=current(),rows=others(),live=[...rows,'more'],more=live.length-1;if(focusIndex>more)focusIndex=0;
      const list=[...Array.from({length:ROWS},(_,i)=>row(rows[i]??null,i,live)),
        h('li',h('button',t('More at {host}',{host})).classes('row','more','control').attrs(defined({type:'button','data-row':'more',tabindex:focusIndex===more?'0':'-1'})).on(arming.guard(provider))).attrs(defined({role:'listitem'}))];
      const action=(name,label,run,extra={})=>actions().includes(name)?h('button',label).classes('action','control',name==='remove'&&'danger').attrs(defined({type:'button',...extra})).on(arming.guard(run)):null;
      return h('div',
        h('header',h('p',t('Your accounts at {host}',{host})).classes('trust','host'),h('p',t("This app can't see this list.")).classes('trust','note')).classes('head'),
        h('button',h('img').classes('tile','large').attrs(defined({alt:'',src:model.tiles[0]??null})),
          h('span',...(me?[h('bdi',me.name??me.handle).classes('name'),h('bdi',me.name?me.handle:'').classes('handle'),h('span',t('Current account')).classes('visually-hidden')]:[h('span',t(model.sandboxed?'Open {host}':'Show my account at {host}',{host})).classes('name')])).classes('text'))
          .classes('card','control').attrs(defined({type:'button','aria-current':me?'true':null,'data-first':''})).on(arming.guard(provider)),
        h('ul',...list).classes('list').attrs(defined({role:'list','aria-label':t('Accounts')})).on({keydown:onListKey}),
        model.confirm
          ?h('div',h('p',t('Remove this account from this site?')).classes('trust','warn'),h('div',h('button',t('Remove')).classes('action','control','danger').attrs(defined({type:'button'})).on(arming.guard(remove)),h('button',t('Cancel')).classes('action','control').attrs(defined({type:'button'})).on(arming.guard(()=>{model.confirm=false;refresh();}))).classes('confirm-buttons')).classes('actions','confirm')
          :h('div',action('use-another',t('Use another account'),()=>startFlow()),action('manage',t('Manage at {host}',{host}),provider),action('remove',t('Remove from this site'),()=>{model.confirm=true;refresh();},{'aria-disabled':me?null:'true'})).classes('actions'),
      ).classes('switcher',model.props.density==='compact'?'compact':'regular');
    },
    start(){
      started=true;
      worker().then(client=>client.on(event=>{if(event.event==='views')update();})).catch(()=>{});update();
      // Programmatic frame focus with no inner target lands on the first control, which exists in every state (EIR-6).
      win.addEventListener('focus',()=>{if(doc.activeElement===doc.body)doc.querySelector('[data-first]')?.focus({preventScroll:true});});
      doc.addEventListener('keydown',event=>{if(event.key!=='Escape'||!event.isTrusted)return;if(model.confirm){model.confirm=false;refresh();return;}send({v:1,type:'escape'});});
    },
    update,
  });
}

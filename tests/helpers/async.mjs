// Keep the deadline referenced: node:test's timeout alone cannot diagnose a wait
// whose last MessagePort/timer has disappeared. Always remove our timer on exit.
export async function within(promise,what,ms=2000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${what} (${ms} ms)`)),ms);})]);}
  finally{clearTimeout(timer);}
}

export async function waitFor(check,what,ms=2000){
  const deadline=Date.now()+ms;
  while(!check()){
    if(Date.now()>=deadline)throw new Error(`Timed out waiting for ${what} (${ms} ms)`);
    await new Promise(resolve=>setTimeout(resolve,1));
  }
}

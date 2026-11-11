// Best-effort delivery while the app is open. The server owns leases, source
// versions, attempt limits and retry times; reopening the app resumes from it.
export function createConversationMemoryDelivery({identity, busy, prepare, now=Date.now, timers=globalThis}) {
  let scope=null,epoch=0,running=false,timer=null;
  const queue=new Map(),cooldown=new Map(),transportAttempts=new Map();
  function reset(next){scope=next;epoch++;running=false;queue.clear();cooldown.clear();transportAttempts.clear();if(timer!==null)timers.clearTimeout(timer);timer=null;}
  function current(){const next=identity()||null;if(next!==scope)reset(next);return scope;}
  function schedule(delay){if(timer!==null)timers.clearTimeout(timer);timer=timers.setTimeout(()=>{timer=null;void pump();},Math.max(0,delay));}
  async function pump(){
    if(!current()||running||!queue.size)return;
    if(busy()){schedule(5000);return;}
    const [companion,due]=[...queue].sort((a,b)=>a[1]-b[1])[0];
    if(due>now()){schedule(due-now());return;}
    const token=epoch;running=true;queue.delete(companion);
    try{
      const result=await prepare({companionId:companion});
      if(!current()||token!==epoch)return;
      transportAttempts.delete(companion);
      if(result?.status==='retry_wait'){
        const at=Date.parse(result.retry_at);
        queue.set(companion,Number.isFinite(at)?Math.max(now()+1000,at):now()+30_000);
      }else if(['ready','unavailable','blocked','exhausted'].includes(result?.status)){
        cooldown.set(companion,now()+(result.status==='blocked'||result.status==='exhausted'?300_000:60_000));
      }else throw Error('Unverified conversation memory delivery');
    }catch(error){
      if(!current()||token!==epoch)return;
      const attempts=(transportAttempts.get(companion)||0)+1;transportAttempts.set(companion,attempts);
      if(![401,403].includes(error?.status)&&!['UNAUTHENTICATED','ACCOUNT_NOT_ALLOWED'].includes(error?.code)&&attempts<3)queue.set(companion,now()+attempts*30_000);
      else cooldown.set(companion,now()+300_000);
    }finally{
      if(token===epoch){running=false;if(queue.size)schedule(Math.max(0,Math.min(...queue.values())-now()));}
    }
  }
  function wake(companions,{force=false}={}){
    if(!current())return;
    for(const companion of companions)if(['alex','mia','juno'].includes(companion)&&(!cooldown.has(companion)||cooldown.get(companion)<=now()||force)&&!queue.has(companion))queue.set(companion,now());
    if(!running&&queue.size)schedule(Math.max(0,Math.min(...queue.values())-now()));
  }
  return {wake,clear:()=>reset(null)};
}

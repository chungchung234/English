// Cloud-confirmed self-report; never a pronunciation or mastery score.
export function createLearningReview({document,rpc,getScope,onOpen,onHome,onNotice,onStale}) {
 const $=id=>document.getElementById(id);
 let rows=[],epoch=0,activeAnalysis=null,busy=false,resuming=false,focusedItemId=null;
 const node=(tag,text,className)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;};
 const button=(text,action)=>{const b=node('button',text,'text-button');b.onclick=action;return b;};
 function reset(){epoch++;rows=[];activeAnalysis=null;busy=false;focusedItemId=null;resuming=false;render();}
 async function load(analysis=null){
  const request=getScope();if(!request)return;
  analysis=analysis||activeAnalysis;
  const ticket=++epoch;
  if(analysis)activeAnalysis=analysis;
  try {
   const result=await rpc('learning_review',{p_companion_id:request.companionId,...(analysis?.id?{p_analysis_id:analysis.id}:{})});
   if(ticket!==epoch||request.key!==getScope()?.key)return;
   if(!Array.isArray(result))throw Error('복습 기록을 확인하지 못했어요.');
   rows=result;render();
  } catch(error){if(ticket!==epoch||request.key!==getScope()?.key)return;if(error.code==='22023'&&analysis){onStale(analysis);return;}onNotice('복습 기록 확인이 필요해요: '+error.message);}
 }
 async function save(item,state,container){
  if(busy)return;busy=true;
  const request=getScope(),ticket=epoch;
  container.querySelectorAll('button').forEach(b=>b.disabled=true);
  const status=node('p','연습 기록 저장 확인 중…','help');status.setAttribute('role','status');container.append(status);
  try{
   const result=await rpc('learning_review',{p_companion_id:request.companionId,p_item_id:item.id,p_state:state});
   if(ticket!==epoch||request.key!==getScope()?.key)return;
   if(!Array.isArray(result)||!result.some(row=>row.id===item.id&&row.state===state))throw Error('서버 저장을 확인하지 못했어요.');
   rows=result;focusedItemId=item.id;render();onNotice(state==='practiced'?'직접 연습한 기록을 저장했어요.':'나중에 이어서 연습할 수 있어요.');
  }catch(error){if(ticket===epoch&&request.key===getScope()?.key){status.textContent='저장하지 못했어요. 표현을 유지하고 다시 시도해 주세요.';container.querySelectorAll('button').forEach(b=>b.disabled=false);onNotice(error.message);}}
  finally{if(ticket===epoch)busy=false;}
 }
 function practice(item){
  const box=node('section',null,'learning-practice');box.append(node('h4',item.state==='practiced'?'직접 연습한 표현':'보고 말해 보세요'));
  if(item.original)box.append(node('p',item.original,'original'));
  const expression=node('p',item.expression,'improved');box.append(expression);
  if(item.reason)box.append(node('p',item.reason));
  const actions=node('div',null,'learning-actions');
  const hide=button('가리고 말하기',()=>{const hidden=expression.dataset.hidden!=='true';expression.dataset.hidden=String(hidden);expression.textContent=hidden?'표현을 떠올려 말해 보세요.':item.expression;hide.textContent=hidden?'표현 보기':'가리고 말하기';hide.setAttribute('aria-pressed',String(hidden));});
  hide.setAttribute('aria-pressed','false');actions.append(hide);
  if(item.state!=='practiced')actions.append(button('직접 연습함',()=>save(item,'practiced',box)),button('나중에 하기',()=>save(item,'later',box)));
  else {box.append(node('p','사용자가 직접 남긴 연습 표시예요.','help'));actions.append(button('홈으로',onHome));}
  box.append(actions);
  if(item.reuse){box.append(node('p','이후 통화에서 같은 표현을 사용했어요.','help'));const quote=node('blockquote',item.reuse.text);box.append(quote);}
  return box;
 }
 function render(){
  const queue=$('learning-queue'),home=$('learning-home');if(!queue||!home)return;
  queue.replaceChildren();const pending=rows.filter(row=>row.state!=='practiced');
  const recent=pending[0]||rows[0];home.hidden=!recent;
  if(recent){home.textContent=(recent.state==='practiced'?'지난 연습 · ':'남겨둔 복습 · ')+recent.expression;home.onclick=()=>onOpen(recent);}
  const session=$('learning-session');if(session){session.replaceChildren();const items=rows.filter(row=>row.analysis_id===activeAnalysis?.id);if(items.length){const next=items.find(row=>row.id===focusedItemId)||items.find(row=>row.state!=='practiced')||items[0];const details=node('details',null,'feedback-context');details.open=next.id===focusedItemId;details.append(node('summary',next.state==='practiced'?'연습 기록 보기':'표현 하나 연습'),practice(next));session.append(details);}}
  if(resuming&&!pending.length&&rows.length)queue.append(practice(rows.find(row=>row.id===focusedItemId)||rows[0]));
  if(pending.length){if(resuming)queue.append(practice(pending[0]));const details=node('details',null,'feedback-context');details.append(node('summary','남겨둔 복습 · '+pending.length+'개'));for(const item of pending)details.append(button(item.expression,()=>onOpen(item)));queue.append(details);}
 }
 return {load,reset,resume(){resuming=true;return load();},show(analysis){resuming=false;activeAnalysis=analysis;load(analysis);}};
}

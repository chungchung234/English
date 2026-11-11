import {AppError,uuidPattern} from './core.ts';

export type PostCallTask={id:string;user_id:string;session_id:string;companion_id:string;kind:'handoff'|'session';source_version:string;revision:number;lease_token:string};
export function requireBackground(req:Request,key:string){
  if(req.headers.has('origin'))throw new AppError(403,'WORKER_ONLY','This endpoint is for server work.');
  const supplied=req.headers.get('authorization')||'',expected='Bearer '+key;
  let difference=supplied.length^expected.length;
  for(let i=0;i<expected.length;i++)difference|=(supplied.charCodeAt(i)||0)^expected.charCodeAt(i);
  if(!key||difference!==0)throw new AppError(401,'UNAUTHENTICATED','Server authentication is required.');
}
export function recoveryOutcome(error:unknown){
  const code=error instanceof AppError?error.code:'WORKER_INTERNAL';
  if(code==='ANALYSIS_CONTINUE')return {outcome:'continue',code,seconds:5};
  if(code==='JOB_IN_PROGRESS')return {outcome:'busy',code,seconds:30};
  if(['BUDGET_EXCEEDED','COST_BUDGET_EXCEEDED'].includes(code))return {outcome:'budget',code,seconds:30};
  if(['UPSTREAM_UNAVAILABLE','DATABASE_UNAVAILABLE','ANALYSIS_UNAVAILABLE','ANALYSIS_RATE_LIMITED','ANALYSIS_INCOMPLETE','INVALID_MODEL_OUTPUT','HISTORY_CHANGED','WORKER_INTERNAL'].includes(code))return {outcome:'retryable',code,seconds:Math.max(1,Math.min(900,error instanceof AppError?error.metadata.retry_seconds??30:30))};
  if(['NO_TRANSCRIPT','SESSION_ACTIVE','SESSION_NOT_FOUND','MEMORY_SOURCE_CHANGED','MEMORY_CHANGED'].includes(code))return {outcome:'cancelled',code,seconds:30};
  return {outcome:'blocked',code,seconds:30};
}
export async function drainPostCall(deps:{rpc:(name:string,body:unknown)=>Promise<unknown>;memory:(task:PostCallTask)=>Promise<unknown>;review:(task:PostCallTask)=>Promise<unknown>}){
  await deps.rpc('discover_post_call_tasks',{});
  const raw=await deps.rpc('claim_post_call_task',{});
  if(raw===null)return {status:'idle'};
  const task=raw as PostCallTask;
  if(!task||['id','user_id','session_id','lease_token'].some(key=>typeof task[key as keyof PostCallTask]!=='string'||!uuidPattern.test(String(task[key as keyof PostCallTask])))
    ||!['alex','mia','juno'].includes(task.companion_id)||!['handoff','session'].includes(task.kind)||!Number.isSafeInteger(task.revision)||task.revision<0||!task.source_version)throw new AppError(503,'BACKGROUND_STATE_UNAVAILABLE','Background state could not be verified.');
  const report=(outcome:string,code:string|null=null,seconds=30)=>deps.rpc('report_post_call_task',{p_id:task.id,p_lease:task.lease_token,p_outcome:outcome,p_error:code,p_retry_seconds:seconds});
  try{
    if(task.kind==='session'){
      await deps.review(task);return await report('ready');
    }
    const result=await deps.memory(task) as {status?:string;retry_at?:string};
    if(result?.status==='ready')return await report('ready');
    if(result?.status==='retry_wait'){
      const delay=Math.ceil((Date.parse(result.retry_at||'')-Date.now())/1000);
      return await report(delay>900?'budget':'busy','MEMORY_RETRY_WAIT',Number.isFinite(delay)?Math.max(1,Math.min(900,delay)):30);
    }
    if(result?.status==='unavailable')return await report('cancelled','SOURCE_UNAVAILABLE');
    if(result?.status==='blocked'||result?.status==='exhausted')return await report(result.status,'MEMORY_'+result.status.toUpperCase());
    throw new AppError(503,'DATABASE_UNAVAILABLE','Memory completion could not be verified.');
  }catch(error){const recovery=recoveryOutcome(error);return await report(recovery.outcome,recovery.code,recovery.seconds);}
}

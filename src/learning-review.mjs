import { createPostCallFlow } from '../web/post-call.js';

// Keep the deployed shell and its inline practice slots; server revisions and
// durable user intent are managed by the shared post-call controller.
export function createLearningReview(options) {
 const flow=createPostCallFlow({
  context:()=>{const scope=options.getScope();if(!scope)return null;const [service,userId]=scope.key.split('|');return {service,userId,companionId:scope.companionId,name:scope.name||scope.companionId,busy:options.isBusy,sync:options.sync};},
  rpc:options.rpc,edge:options.edge,allRows:options.allRows,refresh:options.refresh,
  notice:options.onNotice,setView:options.setView,
  getEventMetadata:options.getEventMetadata,onTelemetryStage:options.onTelemetryStage,
  chooseScenario:()=>options.onPlan?.(),
  onAnalysis:options.onAnalysis,openSession:options.onSession
 });
 return {...flow,reset:flow.clear,resume:async()=>{await flow.load();flow.viewed();},show:flow.show};
}

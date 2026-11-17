// Eyes communicate attention; the silhouette carries pose and measured voice.
export const CHARACTER_PALETTES={alex:[72,86,166],mia:[216,97,120],juno:[75,135,219]};
export const PRESENCE_STATES=['idle','connecting','listening','thinking','speaking','error','ended'];
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
// Deliberate movement -> readable hold -> return -> rest, rather than a sine loop.
export function gestureBeat(time,{period=4.8,delay=.15,attack=.18,hold=.9,release=.3}={}){
 const t=((time%period)+period)%period-delay;
 if(t<0)return 0;
 if(t<attack)return smooth(t/attack);
 if(t<attack+hold)return 1;
 if(t<attack+hold+release)return 1-smooth((t-attack-hold)/release);
 return 0;
}
export function characterPose({profile='alex',time=0,stateTime=time,weights={},input=0,output=0,muted=false,reduced=false,paused=false}={}){
 const neutral={scaleX:1,scaleY:1,tilt:0,gazeX:0,gazeY:0,leftOpen:1,rightOpen:1,eyeWidth:1,eyeTurn:0,eyeCurve:0};
 if(reduced||paused)return neutral;
 const w=name=>weights[name]||0;
 const still=Math.max(w('ended'),w('error'),muted?w('listening'):0),calm=1-still;
 const mia=profile==='mia',juno=profile==='juno';
 const tempo=mia?.82:juno?1.12:1,strength=mia?.78:juno?1.12:.92;
 const t=stateTime*tempo;
 const look=gestureBeat(t),follow=gestureBeat(Math.max(0,t-.10));
 const curiosity=gestureBeat(t,{period:5.2,delay:.2,attack:.22,hold:1.15,release:.34});
 const ambient=Math.sin(time*tempo*.9)*.008*calm;
 const incoming=muted?0:Math.max(0,Math.min(1,input))*w('listening');
 const outgoing=Math.max(0,Math.min(1,output))*w('speaking');
 const listen=w('listening')*calm,think=w('thinking'),speak=w('speaking');
 const connect=w('connecting')*gestureBeat(t,{period:2.8,delay:.1,attack:.25,hold:.65,release:.4});
 const blinkPhase=(time*tempo+1.7)%5.2;
 const blink=blinkPhase<.18?Math.sin(blinkPhase/.18*Math.PI)*calm:0;
 // Capsule -> dot/oval/curved eye: all deformations sample the generated eye art.
 let eyeWidth=1,left=1,right=1,turn=0,curve=0;
 if(mia){
  // Wide, gently curved eyes and a long, unhurried settle.
  const arc=(listen*look+speak*.7)*.95;
  turn=arc*Math.PI/2;curve=arc*.050;eyeWidth-=arc*.56;
  left-=arc*.40;right-=arc*.40;
  turn+=think*curiosity*Math.PI/2;eyeWidth-=think*curiosity*.32;left-=think*curiosity*.35;right-=think*curiosity*.35;
 }else if(juno){
  // Curious dot eyes, then broad sideways ovals, with a jaunty counter-lean.
  const oval=listen*look;
  turn=oval*Math.PI/2;eyeWidth-=oval*.35;left-=oval*.35;right-=oval*.35;
  const dot=think*curiosity;eyeWidth+=dot*.32;left-=dot*.48;right-=dot*.57;
  eyeWidth+=speak*.2;left+=outgoing*.16;right+=outgoing*.24;
 }else{
  // Composed gaze shifts; a clear small-dot thinking pose and open speech eyes.
  const dot=think*curiosity;eyeWidth+=dot*.28;left-=dot*.48;right-=dot*.58;
  eyeWidth+=speak*.14;left+=outgoing*.16;right+=outgoing*.20;
 }
 const quiet=muted*w('listening')*.4+w('error')*.25;
 left=Math.max(.06,left-quiet);right=Math.max(.06,right-quiet);
 // Blink always closes as short horizontal slits, including during curved poses.
 eyeWidth=eyeWidth*(1-blink)+blink;turn*=1-blink;curve*=1-blink;
 left=left*(1-blink)+.06*blink;right=right*(1-blink)+.06*blink;
 const stretch=outgoing*.14*strength+incoming*.035*strength;
 return {
  scaleX:(1+ambient-stretch*.55)*(1-think*.018),
  scaleY:(1+ambient*.7+stretch)*(1-think*.030),
  tilt:calm*(listen*follow*(juno?-.18:mia?.11:.14)+think*follow*(juno?.19:-.13))+outgoing*.065*strength,
  gazeX:calm*listen*look*(juno?-.055:.045)+think*(.034+.025*curiosity)+connect*.026,
  gazeY:calm*listen*look*(juno?.012:-.012)+think*(.028+.035*curiosity)-connect*.010,
  leftOpen:left,rightOpen:right,eyeWidth,eyeTurn:turn,eyeCurve:curve
 };
}

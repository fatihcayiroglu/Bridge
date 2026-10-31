import {
  startLocalHotSeatLiveSession,type LocalHotSeatLiveSession,
} from './pool-local-live-session.ts';
import {type LocalHotSeatMatch} from './pool-local-hotseat.ts';
import {type EightBallPhase} from './pool-eight-ball-rules.ts';
import {activityStringsForLanguage} from './bridge-activities-copy.ts';
import {localHotSeatCallBallIds} from './pool-hotseat-call-options.ts';

export interface LocalPoolHotSeatPanelHandle { dispose():void; }

/**
 * Explicit opt-in offline hot-seat UI. Both people share this single device;
 * there is no network authority, ranked score, persistence or official WPA
 * rules claim. Keep solo practice the default destination.
 */
export function showLocalPoolHotSeat(
  container:HTMLElement,onExit:()=>void,
):LocalPoolHotSeatPanelHandle {
  const s=activityStringsForLanguage(document.documentElement.lang);
  container.replaceChildren();
  let disposed=false;
  let live:LocalHotSeatLiveSession|null=null;
  let lastTurnKey:string|null=null;
  const make=<K extends keyof HTMLElementTagNameMap>(
    tag:K,cls='',value?:string,
  ):HTMLElementTagNameMap[K]=>{
    const el=document.createElement(tag);
    el.className=cls;if(value!==undefined)el.textContent=value;return el;
  };
  const button=(value:string,cls:string,click:()=>void)=>{
    const el=make('button',cls,value);
    el.type='button';el.addEventListener('click',click);return el;
  };
  const back=button(s.poolHotSeatBack,'bridge-room-direction bridge-pool-hotseat-back',()=>{
    if(disposed)return;
    disposed=true;live?.dispose();live=null;onExit();
  });
  const heading=make('h3','bridge-mini-golf-heading',s.poolHotSeatTitle);
  const help=make('p','bridge-activities-help',s.poolHotSeatHelp);
  const canvas=make('canvas','bridge-activities-canvas bridge-pool-canvas');
  canvas.setAttribute('aria-label',s.poolHotSeatTitle);
  const status=make('p','bridge-room-status bridge-pool-hotseat-status');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const groupStatus=make('p','bridge-room-status bridge-pool-hotseat-groups');
  const notice=make('p','bridge-room-status bridge-pool-hotseat-notice');
  notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const controls=make('div','bridge-mini-golf-controls');
  const field=(label:string,cls:string,input:HTMLInputElement|HTMLSelectElement)=>{
    const wrap=make('label','bridge-mini-golf-label',label);
    input.className=cls;wrap.append(input);return wrap;
  };
  const aim=make('input') as HTMLInputElement;
  aim.type='range';aim.min='-70';aim.max='70';aim.step='5';aim.value='0';
  const power=make('input') as HTMLInputElement;
  power.type='range';power.min='10';power.max='100';power.step='5';power.value='60';
  const safety=make('input') as HTMLInputElement;
  safety.type='checkbox';safety.className='bridge-pool-hotseat-safety';
  const ball=make('select') as HTMLSelectElement;
  const pocket=make('select') as HTMLSelectElement;
  s.poolPocketNames.forEach((name,id)=>{
    const option=make('option','',name);option.value=String(id);pocket.append(option);
  });
  const shoot=button(s.poolShoot,'bridge-room-direction bridge-pool-hotseat-shoot',()=>{
    if(disposed||!live)return;
    const state=live.match;
    const intent=state.rules.phase==='break'?{kind:'break'} as const:
      safety.checked?{kind:'safety'} as const:
      {kind:'ball' as const,ballId:Number(ball.value),pocketIndex:Number(pocket.value)};
    if(!live.shoot(state.rules.currentPlayer,Number(aim.value),Number(power.value),intent))
      notice.textContent=s.poolHotSeatInvalid;
    else{notice.textContent=live.status==='moving'?s.poolHotSeatPending:'';refresh(live.match);}
  });
  controls.append(field(s.poolAim,'bridge-pool-hotseat-aim',aim),
    field(s.poolPower,'bridge-pool-hotseat-power',power),
    field(s.poolHotSeatSafety,'bridge-pool-hotseat-safety',safety),
    field(s.poolCallBall,'bridge-pool-hotseat-ball',ball),
    field(s.poolCallPocket,'bridge-pool-hotseat-pocket',pocket),shoot);
  safety.addEventListener('change',()=>{if(live)refresh(live.match);});
  const decisions=make('div','bridge-mini-golf-controls bridge-pool-hotseat-decisions');
  const offer=(value:string,act:()=>boolean)=>{
    decisions.append(button(value,'bridge-room-direction',()=>{
      if(!live||disposed)return;
      if(!act())notice.textContent=s.poolHotSeatInvalid;
      else notice.textContent='';
      refresh(live.match);
    }));
  };
  const phases:Record<EightBallPhase,string>={
    break:s.poolHotSeatBreak,open:s.poolHotSeatOpen,
    assigned:s.poolHotSeatAssigned,'choose-group':s.poolHotSeatChooseGroup,
    'illegal-break-choice':s.poolHotSeatIllegalBreak,
    'break-foul-choice':s.poolHotSeatBreakFoul,
    'eight-respot-required':s.poolHotSeatEightRespot,finished:s.poolHotSeatFinished,
  };
  function refresh(snapshot:LocalHotSeatMatch):void {
    if(disposed)return;
    const rules=snapshot.rules,actor=rules.currentPlayer;
    const turnKey=rules.shotsResolved+':'+actor;
    if(lastTurnKey!==turnKey){
      // Safety is always a deliberate per-turn choice, never an inherited
      // selection that silently passes the next player's turn.
      safety.checked=false;lastTurnKey=turnKey;
    }
    const previousBall=ball.value;
    const calledIds=localHotSeatCallBallIds(snapshot);
    ball.replaceChildren(...calledIds.map(id=>{
      const option=make('option','',String(id));option.value=String(id);return option;
    }));
    if(calledIds.includes(Number(previousBall)))ball.value=previousBall;
    groupStatus.textContent=[0,1].map(i=>s.poolHotSeatPlayer+' '+(i+1)+': '+
      (rules.groups[i]==='solids'?s.poolHotSeatSolidsGroup:
       rules.groups[i]==='stripes'?s.poolHotSeatStripesGroup:s.poolHotSeatUnassigned)
    ).join(' · ');
    const blocked=live?.status==='blocked'||live?.status==='disposed';
    const moving=live?.status==='moving';
    status.textContent=rules.phase==='finished'&&rules.winner!==null
      ?s.poolHotSeatWinner+' '+(rules.winner+1)
      :s.poolHotSeatPlayer+' '+(actor+1)+' · '+phases[rules.phase]+
       ' · '+s.poolShots+': '+snapshot.table.shots;
    if(blocked)notice.textContent=s.poolHotSeatBlocked;
    const available=!blocked&&!moving&&(live?.graphicsAvailable??true);
    const canShoot=available&&snapshot.table.status==='ready'&&rules.ballInHand===null&&
      (rules.phase==='break'||rules.phase==='open'||rules.phase==='assigned');
    const called=rules.phase!=='break'&&canShoot;
    const canCall=called&&calledIds.length>0;
    shoot.disabled=!canShoot||(called&&!safety.checked&&!canCall);
    aim.disabled=!canShoot;power.disabled=!canShoot;
    safety.disabled=!called;
    ball.disabled=!canCall||safety.checked;
    pocket.disabled=!canCall||safety.checked;
    decisions.replaceChildren();
    if(!available)return;
    if(rules.phase==='choose-group'){
      offer(s.poolHotSeatSolids,()=>live!.chooseGroup(actor,'solids'));
      offer(s.poolHotSeatStripes,()=>live!.chooseGroup(actor,'stripes'));
    }else if(rules.phase==='illegal-break-choice'){
      offer(s.poolHotSeatAccept,()=>live!.chooseIllegalBreak(actor,'accept-position'));
      offer(s.poolHotSeatRerackIncoming,
        ()=>live!.chooseIllegalBreak(actor,'rerack-incoming-break'));
      offer(s.poolHotSeatRerackOriginal,
        ()=>live!.chooseIllegalBreak(actor,'rerack-original-break'));
    }else if(rules.phase==='break-foul-choice'){
      offer(s.poolHotSeatHeadString,
        ()=>live!.chooseBreakFoul(actor,'take-head-string'));
      offer(s.poolHotSeatAccept,()=>live!.chooseBreakFoul(actor,'accept-position'));
    }else if(rules.phase==='eight-respot-required'){
      offer(s.poolHotSeatSpotEight,()=>live!.chooseEightOnBreak(actor,'spot-eight'));
      offer(s.poolHotSeatRerack,()=>live!.chooseEightOnBreak(actor,'rerack'));
    }
    if(rules.ballInHand!==null){
      const x=make('input') as HTMLInputElement,z=make('input') as HTMLInputElement;
      x.type='number';x.step='0.1';x.min='-1.9';x.max='1.9';x.value='0';
      z.type='number';z.step='0.1';z.min='-3.8';z.max='3.8';z.value='2.7';
      decisions.append(field('X','bridge-pool-hotseat-place-x',x),
        field('Z','bridge-pool-hotseat-place-z',z));
      offer(s.poolHotSeatPlace,()=>x.value.trim()!==''&&z.value.trim()!==''&&
        live!.placeCue(actor,Number(x.value),Number(z.value)));
    }
  }
  container.append(back,heading,help,canvas,status,groupStatus,notice,controls,decisions);
  try{
    live=startLocalHotSeatLiveSession(canvas,refresh);
    if(!live){
      notice.textContent=s.noWebgl;shoot.disabled=true;aim.disabled=true;
      power.disabled=true;safety.disabled=true;ball.disabled=true;pocket.disabled=true;
    }else refresh(live.match);
  }catch{
    live?.dispose();live=null;
    notice.textContent=s.noWebgl;shoot.disabled=true;aim.disabled=true;
    power.disabled=true;safety.disabled=true;ball.disabled=true;pocket.disabled=true;
  }
  return {dispose(){if(disposed)return;disposed=true;live?.dispose();live=null;}};
}

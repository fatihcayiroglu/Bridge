import {
  startPoolPractice, type PoolPracticeHandle,
} from './pool-practice-webgl.ts';
import {type PoolState} from './pool-practice-physics.ts';
import {declareLocalPoolCall,resolveLocalCalledEightBallShot,
  type LocalPoolCall} from './pool-called-pocket.ts';
import {resolveLocalEightBallShot,type EightBallPlayer,type EightBallGroup,
  type IllegalBreakChoice,type LocalEightBallRules} from './pool-eight-ball-rules.ts';
import {
  chooseHotSeatBreakFoul,chooseHotSeatEightOnBreak,chooseHotSeatGroup,
  chooseHotSeatIllegalBreak,newLocalHotSeatMatch,placeHotSeatCue,
  type LocalHotSeatMatch,type LocalTurnIntent,
} from './pool-local-hotseat.ts';
import {type LocalEightBreakChoice} from './pool-eight-on-break.ts';

/**
 * Local-only live 3D turn adapter used by the experimental Activities
 * hot-seat screen. Physics owns every shot trace; no caller-provided shot
 * outcomes or networked 8-Ball scores are accepted.
 */
export interface LocalHotSeatLiveSession {
  readonly match:LocalHotSeatMatch;
  readonly status:'ready'|'moving'|'blocked'|'disposed';
  readonly graphicsAvailable:boolean;
  shoot(actor:EightBallPlayer,angle:number,power:number,intent:LocalTurnIntent):boolean;
  chooseGroup(actor:EightBallPlayer,group:EightBallGroup):boolean;
  chooseIllegalBreak(actor:EightBallPlayer,choice:IllegalBreakChoice):boolean;
  chooseBreakFoul(actor:EightBallPlayer,choice:'take-head-string'|'accept-position'):boolean;
  chooseEightOnBreak(actor:EightBallPlayer,choice:LocalEightBreakChoice):boolean;
  placeCue(actor:EightBallPlayer,x:number,z:number):boolean;
  dispose():void;
}

type Factory=typeof startPoolPractice;
type Pending={readonly before:PoolState;readonly rules:LocalEightBallRules;
  readonly call:LocalPoolCall|null};
const copyTable=(s:PoolState):PoolState=>({...s,balls:s.balls.map(b=>({...b})),
  breakObjectRails:[...s.breakObjectRails],pocketEvents:s.pocketEvents.map(e=>({...e}))});
const copyMatch=(m:LocalHotSeatMatch):LocalHotSeatMatch=>({
  table:copyTable(m.table),
  rules:{...m.rules,groups:[...m.rules.groups] as [typeof m.rules.groups[0],typeof m.rules.groups[1]],
    last:m.rules.last?{...m.rules.last,pocketed:[...m.rules.last.pocketed]}:null},
});
const sameTable=(a:PoolState,b:PoolState):boolean=>
  JSON.stringify(a)===JSON.stringify(b);

export function startLocalHotSeatLiveSession(
  canvas:HTMLCanvasElement,onMatch:(snapshot:LocalHotSeatMatch)=>void,
  factory:Factory=startPoolPractice,
):LocalHotSeatLiveSession|null {
  let match=newLocalHotSeatMatch();
  let pending:Pending|null=null;
  let blocked=false,disposed=false,renderer:PoolPracticeHandle|null=null;
  const notify=()=>onMatch(copyMatch(match));
  const onState=(frame:PoolState)=>{
    if(disposed||blocked||!pending)return;
    if(frame.status==='moving')return;
    const shot=pending;pending=null;
    if(frame.shots!==shot.before.shots+1||frame.status!=='ready'&&
        frame.status!=='complete') {blocked=true;notify();return;}
    const next=shot.call
      ?resolveLocalCalledEightBallShot(shot.rules,shot.before,frame,shot.call)?.rules??null
      :resolveLocalEightBallShot(shot.rules,shot.before,frame);
    if(!next){blocked=true;notify();return;}
    match={table:copyTable(frame),rules:next};
    notify();
  };
  const onLost=()=>{blocked=true;pending=null;notify();};
  try{renderer=factory(canvas,onState,onLost);}
  catch{return null;}
  if(!renderer)return null;
  if(!renderer.isGraphicsAvailable||!sameTable(renderer.state,match.table)){
    renderer.dispose();return null;
  }
  const ready=()=>!disposed&&!blocked&&!pending&&
    renderer!.isGraphicsAvailable&&sameTable(renderer!.state,match.table);
  function apply(decision:LocalHotSeatMatch|null):boolean {
    if(!decision||!ready())return false;
    if(!sameTable(decision.table,match.table)) {
      if(decision.table.shots===0 && match.table.shots>0 &&
          decision.rules.phase==='break') {
        renderer!.reset();
        if(!sameTable(renderer!.state,decision.table)){blocked=true;return false;}
      } else if(!renderer!.placeLocalTable(decision.table)){
        return false;
      }
      if(!sameTable(renderer!.state,decision.table)){blocked=true;return false;}
    }
    match=copyMatch(decision);notify();return true;
  }
  notify();
  return {
    get match(){return copyMatch(match);},
    get status(){return disposed?'disposed':blocked?'blocked':pending?'moving':'ready';},
    get graphicsAvailable(){return !disposed&&!blocked&&renderer!.isGraphicsAvailable;},
    shoot(actor,angle,power,intent){
      if(!ready()||!intent||actor!==match.rules.currentPlayer||
          (actor!==0&&actor!==1)||match.rules.winner!==null||
          match.rules.ballInHand!==null||match.table.status!=='ready')return false;
      const opening=match.rules.phase==='break';
      if(opening?intent.kind!=='break':
          (match.rules.phase!=='open'&&match.rules.phase!=='assigned')||
          (intent.kind!=='safety'&&intent.kind!=='ball'))return false;
      const call=intent.kind==='break'?null:declareLocalPoolCall(match.rules,match.table,
        actor,intent.kind,intent.kind==='ball'?intent.ballId:undefined,
        intent.kind==='ball'?intent.pocketIndex:undefined);
      if(!opening&&!call)return false;
      const before=copyTable(renderer!.state);
      pending={before,rules:match.rules,call};
      if(!renderer!.shoot(angle,power)){pending=null;return false;}
      return true;
    },
    chooseGroup(actor,group){return apply(chooseHotSeatGroup(match,actor,group));},
    chooseIllegalBreak(actor,choice){
      return apply(chooseHotSeatIllegalBreak(match,actor,choice));
    },
    chooseBreakFoul(actor,choice){return apply(chooseHotSeatBreakFoul(match,actor,choice));},
    chooseEightOnBreak(actor,choice){
      return apply(chooseHotSeatEightOnBreak(match,actor,choice));
    },
    placeCue(actor,x,z){return apply(placeHotSeatCue(match,actor,x,z));},
    dispose(){if(disposed)return;disposed=true;pending=null;renderer!.dispose();},
  };
}

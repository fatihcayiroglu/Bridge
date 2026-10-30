import {
  POOL_POCKETS, type PoolState,
} from './pool-practice-physics.ts';
import { resolveLocalEightBallShot, type EightBallPlayer,
  type LocalEightBallRules } from './pool-eight-ball-rules.ts';

/**
 * Pure LOCAL-ONLY call-shot candidate, not wired to online or the existing
 * solo-practice UI. WPA 1.7 and 4.4–4.8: declare one intended ball/pocket
 * (or safety) before the shot. Called eight must have the player's assigned
 * group cleared before the shot. A physical pocket trace is necessary but
 * not sufficient to adjudicate a legal win/foul or award a turn.
 */
export type LocalPoolCall =
  | { readonly kind:'ball'; readonly player:EightBallPlayer;
      readonly shot:number; readonly ballId:number; readonly pocketIndex:number }
  | { readonly kind:'safety'; readonly player:EightBallPlayer;
      readonly shot:number };

export interface LocalPoolCallOutcome {
  /** The selected ball entered the *declared* pocket. Not an award of turn. */
  readonly calledBallInPocket:boolean;
  /** Calling safety deliberately passes the turn, even when targets fall. */
  readonly safety:boolean;
  /** Eight entered a different pocket / was not the selected ball. */
  readonly eightPocketedOutsideCall:boolean;
  /** A cue scratch occurred (other fouls must be checked by the rules engine). */
  readonly scratched:boolean;
}

const isObject=(id:number):boolean => Number.isSafeInteger(id)&&id>=1&&id<=15;
const inGroup=(id:number,group:'solids'|'stripes'):boolean =>
  group==='solids' ? id>=1&&id<=7 : id>=9&&id<=15;
function inventory(s:PoolState):Map<number,boolean>|null {
  if(s.balls.length!==16||!Number.isSafeInteger(s.pocketed)||s.pocketed<0)return null;
  const m=new Map<number,boolean>();
  for(const b of s.balls) {
    if(!Number.isSafeInteger(b.id)||b.id<0||b.id>15||
        m.has(b.id)||typeof b.pocketed!=='boolean')return null;
    m.set(b.id,b.pocketed);
  }
  if(m.size!==16||m.get(0)===true ||
      [...m].filter(([id,p])=>id!==0&&p).length!==s.pocketed)return null;
  return m;
}

export function declareLocalPoolCall(
  rules:LocalEightBallRules, before:PoolState,
  player:EightBallPlayer, kind:'ball'|'safety',
  ballId?:number, pocketIndex?:number,
):LocalPoolCall|null {
  if((player!==0&&player!==1)||player!==rules.currentPlayer||
      rules.winner!==null||rules.ballInHand!==null||
      (rules.phase!=='open'&&rules.phase!=='assigned')||
      before.shots!==rules.shotsResolved||before.status!=='ready'||
      !Number.isSafeInteger(before.shots)||before.shots>=999||
      !inventory(before))return null;
  if(kind==='safety') {
    if(ballId!==undefined||pocketIndex!==undefined)return null;
    return {kind,player,shot:before.shots+1};
  }
  if(kind!=='ball'||!isObject(ballId!)||
      !Number.isSafeInteger(pocketIndex)||pocketIndex!<0||
      pocketIndex!>=POOL_POCKETS.length)return null;
  if(before.balls.some(b=>b.id===ballId&&b.pocketed))return null;
  if(rules.phase==='open') {
    // WPA has an exceptional open-table eight-ball option if one class
    // is cleared; no explicit temporary group claim exists here yet.
    if(ballId===8)return null;
  }else{
    const group=rules.groups[player];
    if(group!=='solids'&&group!=='stripes')return null;
    const remaining=before.balls.some(b=>!b.pocketed&&inGroup(b.id,group));
    if(remaining ? !inGroup(ballId!,group) : ballId!==8)return null;
  }
  return {kind:'ball',player,shot:before.shots+1,ballId:ballId!,pocketIndex:pocketIndex!};
}

/**
 * Refuse corrupt or incomplete physical evidence rather than silently
 * accepting a different pocket, a resurrected object or a spoofed ball.
 * The call is evaluated separately from official fouls / final turn rules.
 */
export function evaluateLocalPoolCall(
  rules:LocalEightBallRules,before:PoolState,after:PoolState,
  call:LocalPoolCall,
):LocalPoolCallOutcome|null {
  const expected=declareLocalPoolCall(rules,before,call.player,call.kind,
    call.kind==='ball'?call.ballId:undefined,
    call.kind==='ball'?call.pocketIndex:undefined);
  if(!expected||call.shot!==expected.shot||
      after.shots!==expected.shot||after.status==='moving'||
      !Number.isSafeInteger(after.scratches)||!Number.isSafeInteger(before.scratches)||
      after.scratches<before.scratches||after.scratches>before.scratches+1 ||
      !Array.isArray(after.pocketEvents)||after.pocketEvents.length>16)return null;
  const old=inventory(before),current=inventory(after);
  if(!old||!current)return null;
  const newly=new Set<number>();
  for(let id=1;id<=15;id++) {
    if(old.get(id)&&!current.get(id))return null;
    if(!old.get(id)&&current.get(id))newly.add(id);
  }
  if(after.pocketed-before.pocketed!==newly.size)return null;
  const eventIds=new Set<number>();
  for(const event of after.pocketEvents) {
    if(!Number.isSafeInteger(event.ballId)||event.ballId<0||event.ballId>15||
        !Number.isSafeInteger(event.pocketIndex)||event.pocketIndex<0||
        event.pocketIndex>=POOL_POCKETS.length||eventIds.has(event.ballId))
      return null;
    eventIds.add(event.ballId);
    if(event.ballId!==0&&!newly.has(event.ballId))return null;
  }
  for(const id of newly)if(!eventIds.has(id))return null;
  const scratched=after.scratches>before.scratches;
  if(eventIds.has(0)!==scratched)return null;
  const calledBallInPocket=call.kind==='ball'&&after.pocketEvents.some(e=>
    e.ballId===call.ballId&&e.pocketIndex===call.pocketIndex);
  const eightPocketedOutsideCall=newly.has(8)&&
    !(call.kind==='ball'&&call.ballId===8&&calledBallInPocket);
  return {
    calledBallInPocket,
    safety:call.kind==='safety',
    eightPocketedOutsideCall,
    scratched,
  };
}

/**
 * Strict local integration: unlike the older exploratory reducer, table
 * ownership and turn retention depend on the CALLED ball entering the
 * declared pocket. A safety always passes; a miscalled black loses.
 * This does not convert the mode into a server-authoritative match or
 * cover other unmodeled WPA fouls.
 */
export interface LocalCalledEightBallResolution {
  readonly rules:LocalEightBallRules;
  readonly evidence:LocalPoolCallOutcome;
}
export function resolveLocalCalledEightBallShot(
  rules:LocalEightBallRules,before:PoolState,after:PoolState,
  call:LocalPoolCall,
):LocalCalledEightBallResolution|null {
  const evidence=evaluateLocalPoolCall(rules,before,after,call);
  if(!evidence)return null;
  const next=resolveLocalEightBallShot(rules,before,after);
  if(!next||!next.last||next.last.actor!==call.player||
      next.phase==='illegal-break-choice'||next.phase==='break-foul-choice'||
      next.phase==='eight-respot-required')return null;
  const opponent:EightBallPlayer=call.player===0?1:0;
  if(evidence.eightPocketedOutsideCall) {
    return {evidence,rules:{...next,phase:'finished',winner:opponent,
      ballInHand:null,last:{...next.last,retainedTurn:false}}};
  }
  if(next.phase==='finished') {
    // Only the declared 8 in its declared pocket can win. Underlying
    // physics still handles early 8 and scratch losses.
    if(!evidence.calledBallInPocket||call.kind!=='ball'||call.ballId!==8)
      return null;
    return {evidence,rules:next};
  }
  const keepTurn=!evidence.safety&&evidence.calledBallInPocket&&next.last.foul===null;
  const common={...next,currentPlayer:keepTurn?call.player:opponent,
    last:{...next.last,retainedTurn:keepTurn}};
  if(rules.phase==='open') {
    if(keepTurn&&call.kind==='ball'&&call.ballId!==8) {
      const group: 'solids'|'stripes'=call.ballId<=7?'solids':'stripes';
      const opposite:'solids'|'stripes'=group==='solids'?'stripes':'solids';
      const groups:readonly ['solids'|'stripes','solids'|'stripes']=
        call.player===0?[group,opposite]:[opposite,group];
      return {evidence,rules:{...common,phase:'assigned',groups}};
    }
    // Even if several groups fell, missed/unannounced calls or a safety
    // NEVER assign ownership by the order of the physics array.
    return {evidence,rules:{...common,phase:'open',groups:[null,null]}};
  }
  if(rules.phase!=='assigned'||(next.phase!=='assigned'&&next.phase!=='choose-group'))
    return null;
  return {evidence,rules:{...common,phase:'assigned',groups:rules.groups}};
}

import { newPoolPractice, type PoolState } from './pool-practice-physics.ts';

/**
 * LOCAL ONLY: pure rules foundation for the experimental offline hot-seat
 * preview. This is not complete or certified WPA competitive adjudication;
 * ambiguous cases must fail closed rather than inventing wins.
 */
export type EightBallGroup = 'solids' | 'stripes';
export type EightBallPlayer = 0 | 1;
export type EightBallFoul =
  | 'scratch' | 'no-first-contact' | 'illegal-first-contact' | 'no-rail-after-contact' | 'illegal-break';
export type EightBallPhase =
  | 'break' | 'open' | 'assigned' | 'choose-group' | 'illegal-break-choice' | 'break-foul-choice' | 'eight-respot-required' | 'finished';

export interface EightBallShotResult {
  readonly actor: EightBallPlayer;
  readonly pocketed: readonly number[];
  readonly firstObjectHit: number | null;
  readonly foul: EightBallFoul | null;
  readonly retainedTurn: boolean;
  readonly eightPocketed: boolean;
}

export interface LocalEightBallRules {
  readonly phase: EightBallPhase;
  readonly currentPlayer: EightBallPlayer;
  readonly groups: readonly [EightBallGroup | null, EightBallGroup | null];
  readonly winner: EightBallPlayer | null;
  readonly shotsResolved: number;
  readonly last: EightBallShotResult | null;
  /** After a non-terminal foul the incoming player must physically place the cue. */
  readonly ballInHand: 'anywhere' | 'head-string' | null;
}

export function newLocalEightBallRules(): LocalEightBallRules {
  return {
    phase: 'break', currentPlayer: 0, groups: [null, null],
    winner: null, shotsResolved: 0, last: null, ballInHand: null,
  };
}

const other = (p: EightBallPlayer): EightBallPlayer => p===0 ? 1 : 0;
const groupOf = (id: number): EightBallGroup | null =>
  id>=1&&id<=7?'solids':id>=9&&id<=15?'stripes':null;

function mapBalls(s: PoolState): Map<number, boolean> | null {
  if(s.balls.length!==16)return null;
  const ids=new Map<number,boolean>();
  for(const b of s.balls) {
    if(!Number.isSafeInteger(b.id)||b.id<0||b.id>15||ids.has(b.id) ||
        typeof b.pocketed!=='boolean')return null;
    ids.set(b.id,b.pocketed);
  }
  return ids.size===16?ids:null;
}

/**
 * Can only resolve one completed, consecutive *real* physics shot.
 * Null is a refusal, not a valid result. This never affects the existing
 * single-player practice, sockets, persistent scores or multiplayer.
 */
export function resolveLocalEightBallShot(
  rules: LocalEightBallRules, before: PoolState, after: PoolState,
): LocalEightBallRules | null {
  if(rules.phase==='finished'||rules.phase==='choose-group'||
      rules.phase==='illegal-break-choice'||rules.phase==='break-foul-choice'||
      rules.phase==='eight-respot-required'||rules.winner!==null ||
      rules.ballInHand!==null ||
      before.shots!==rules.shotsResolved || after.shots!==before.shots+1 ||
      before.status!=='ready'||after.status==='moving' ||
      after.scratches<before.scratches||after.scratches>before.scratches+1 ||
      !Number.isSafeInteger(after.shots)||!Number.isSafeInteger(after.pocketed)||
      !Number.isSafeInteger(before.pocketed)||
      typeof after.railAfterContact!=='boolean')return null;
  // All observed cushion contacts are unique physical object IDs. The
  // practice engine only records these on shot one; later shots reset them.
  const breakRails=after.breakObjectRails;
  if(!Array.isArray(before.breakObjectRails)||!Array.isArray(breakRails)||
      (before.shots===0&&before.breakObjectRails.length!==0)||
      (after.shots!==1&&breakRails.length!==0)||
      breakRails.length>15||new Set(breakRails).size!==breakRails.length||
      breakRails.some(id=>!Number.isSafeInteger(id)||id<1||id>15)||
      (breakRails.length>0&&(!after.railAfterContact||after.firstObjectHit===null)))
    return null;
  const old=mapBalls(before),now=mapBalls(after);
  if(!old||!now||old.get(0)||now.get(0))return null;
  const pocketed: number[]=[];
  for(let id=1;id<=15;id++) {
    if(old.get(id)&&!now.get(id))return null; // never un-pocket an object
    if(!old.get(id)&&now.get(id))pocketed.push(id);
  }
  if(pocketed.length!==after.pocketed-before.pocketed ||
      after.pocketed!==[...now].filter(([id,isPocketed])=>id!==0&&isPocketed).length ||
      before.pocketed!==[...old].filter(([id,isPocketed])=>id!==0&&isPocketed).length)
    return null;
  const hit=after.firstObjectHit;
  if(hit!==null &&
      (!Number.isSafeInteger(hit)||hit<1||hit>15||old.get(hit)))return null;

  const actor=rules.currentPlayer;
  const myGroup=rules.groups[actor];
  const isBreak=rules.phase==='break';
  const ownRemainingBefore=myGroup!==null &&
    [...old].some(([id,isPocketed])=>!isPocketed && groupOf(id)===myGroup);
  const requiredEight=myGroup!==null&&!ownRemainingBefore;
  const scratch=after.scratches>before.scratches;
  let foul:EightBallFoul|null=null;
  if(scratch)foul='scratch';
  else if(hit===null)foul='no-first-contact';
  else if((!isBreak && myGroup===null && hit===8) ||
      (myGroup!==null && (requiredEight?hit!==8:groupOf(hit)!==myGroup)))
    foul='illegal-first-contact';
  else if(pocketed.length===0&&!after.railAfterContact)
    foul='no-rail-after-contact';

  const eightPocketed=pocketed.includes(8);
  const eligibleObjects=pocketed.filter(id=>groupOf(id)===myGroup);
  const goodPocket=foul===null && (myGroup===null
    ?pocketed.some(id=>id!==8):eligibleObjects.length>0);
  const retainedTurn=goodPocket&&!eightPocketed;
  const result:EightBallShotResult={
    actor,pocketed,firstObjectHit:hit,foul,retainedTurn,eightPocketed,
  };
  const common={shotsResolved:after.shots,last:result};
  // Never accept the solo-practice auto-respot as a real placement.
  // Standard fouls award anywhere placement; break fouls require an
  // explicit opponent decision before head-string placement can be granted.
  const ballInHand: 'anywhere'|'head-string'|null = foul&&!isBreak?'anywhere':null;
  if(eightPocketed) {
    if(isBreak) {
      // Eight on break is not an automatic win/loss. Physics must re-spot it
      // safely before any next shot, so do not advance this candidate match.
      return {...rules,...common,phase:'eight-respot-required',
        currentPlayer:foul?other(actor):actor,ballInHand:null};
    }
    const legalEight=requiredEight&&hit===8&&!foul;
    return {...rules,...common,phase:'finished',
      winner:legalEight?actor:other(actor),currentPlayer:actor,ballInHand:null};
  }
  if(isBreak) {
    // WPA: if no object was pocketed, four DIFFERENT object balls must
    // reach a cushion. The incoming player may accept the table or choose
    // who re-breaks. Never auto-resolve those physical choices in this
    // unfinished candidate mode.
    if(pocketed.length===0&&breakRails.length<4) {
      return {...rules,shotsResolved:after.shots,
        last:{...result,foul:foul??'illegal-break',retainedTurn:false},
        phase:'illegal-break-choice',currentPlayer:other(actor),ballInHand:null};
    }
    // WPA 4.3(h): even on a legal break, an ordinary foul grants the
    // incoming player a CHOICE, not automatic head-string ball-in-hand.
    if(foul)return {...rules,...common,phase:'break-foul-choice',
      ballInHand:null,currentPlayer:other(actor)};
    // Table stays open after break even if a solid/stripe was sunk.
    return {...rules,...common,phase:'open',ballInHand,
      currentPlayer:retainedTurn?actor:other(actor)};
  }
  if(rules.phase==='open') {
    const classes=[...new Set(pocketed.map(groupOf).filter(
      (g):g is EightBallGroup=>g!==null))];
    if(foul===null&&classes.length===1) {
      const group=classes[0]!;
      const opposite:EightBallGroup=group==='solids'?'stripes':'solids';
      const groups:readonly [EightBallGroup,EightBallGroup]=actor===0
        ?[group,opposite]:[opposite,group];
      return {...rules,...common,groups,phase:'assigned',currentPlayer:actor};
    }
    if(foul===null&&classes.length===2) {
      // No authoritative called-pocket contract yet. A human choice is
      // required; never silently grant a group based on mesh/array order.
      return {...rules,...common,phase:'choose-group',currentPlayer:actor};
    }
  }
  return {...rules,...common,phase:myGroup===null?'open':'assigned',ballInHand,
    currentPlayer:retainedTurn?actor:other(actor)};
}

export function chooseLocalEightBallGroup(
  rules: LocalEightBallRules, group: EightBallGroup,
): LocalEightBallRules | null {
  if(rules.phase!=='choose-group'||rules.winner!==null||
      (group!=='solids'&&group!=='stripes'))return null;
  const opposite:EightBallGroup=group==='solids'?'stripes':'solids';
  const groups:readonly [EightBallGroup,EightBallGroup]=rules.currentPlayer===0
    ?[group,opposite]:[opposite,group];
  return {...rules,groups,phase:'assigned'};
}

/**
 * Atomic local-only response to an illegal break. The three WPA choices are
 * explicit: accept the untouched settled layout, or physically re-rack with
 * the incoming/original player breaking. A scratch cannot silently accept
 * the solo-practice auto-re-spotted cue as legal ball-in-hand: fail closed.
 * This API is not bound to Bridge UI or a socket and does not modify inputs.
 */
export type IllegalBreakChoice =
  | 'accept-position' | 'rerack-incoming-break' | 'rerack-original-break';
export interface IllegalBreakResolution {
  readonly rules: LocalEightBallRules;
  readonly table: PoolState;
}
export function chooseLocalIllegalBreak(
  rules: LocalEightBallRules,
  table: PoolState,
  choice: IllegalBreakChoice,
): IllegalBreakResolution | null {
  const last=rules.last;
  if(rules.phase!=='illegal-break-choice'||rules.winner!==null||
      !last||last.actor===rules.currentPlayer||last.pocketed.length!==0||
      table.status!=='ready'||table.shots!==rules.shotsResolved||
      !mapBalls(table)||table.pocketed!==0||
      (choice!=='accept-position'&&choice!=='rerack-incoming-break'&&
       choice!=='rerack-original-break'))return null;
  if(choice==='accept-position') {
    // A scratch or another simultaneous foul needs an explicit legal
    // head-string ball-in-hand flow before continuing: not implemented.
    if(last.foul!=='illegal-break'||table.scratches!==0)return null;
    return {rules:{...rules,phase:'open'},table};
  }
  const breaker=choice==='rerack-incoming-break'?rules.currentPlayer:last.actor;
  return {rules:{...newLocalEightBallRules(),currentPlayer:breaker},
    table:newPoolPractice()};
}

/**
 * WPA 8-Ball 4.3(h) local-only break foul options. A scratch is auto-respotted
 * by SOLO practice physics, so the untouched-table option is not provable:
 * fail closed rather than silently using a fictional legally placed cue.
 * The explicit head-string choice creates a one-shot placement permission.
 */
export function chooseLocalBreakFoul(
  rules: LocalEightBallRules, table: PoolState,
  choice: 'take-head-string' | 'accept-position',
): LocalEightBallRules | null {
  if(rules.phase!=='break-foul-choice'||rules.ballInHand!==null||
      rules.winner!==null||!rules.last||rules.last.foul===null||
      rules.last.actor===rules.currentPlayer||
      table.status!=='ready'||table.shots!==rules.shotsResolved||
      !mapBalls(table)||
      (choice!=='take-head-string'&&choice!=='accept-position'))return null;
  if(choice==='take-head-string') {
    return {...rules,phase:'open',ballInHand:'head-string'};
  }
  if(rules.last.foul==='scratch'||table.scratches>0)return null;
  return {...rules,phase:'open',ballInHand:null};
}

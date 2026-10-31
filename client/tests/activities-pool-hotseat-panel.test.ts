import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {showBridgeActivities} from '../js/core/activities/bridge-activities-panel.ts';
import {newPoolPractice,strikePool,stepPool,type PoolState} from
  '../js/core/activities/pool-practice-physics.ts';
import {acceptLocalPoolPlacement} from '../js/core/activities/pool-local-placement.ts';
import {startPoolPractice,type PoolPracticeHandle} from '../js/core/activities/pool-practice-webgl.ts';

const renderer=vi.hoisted(()=>({disposes:vi.fn(),
  mode:'real' as 'real'|'forged'|'deferred-forged'|'deferred-real'|'unavailable',
  emit:null as null|(()=>void),lose:null as null|(()=>void)}));
vi.mock('../js/core/exclusive-surface.ts',()=>({closeExclusivePeers:vi.fn()}));
vi.mock('../js/core/bridge-registry.ts',()=>({BridgeRegistry:{
  register:vi.fn(),call:vi.fn(()=>null),get:vi.fn(()=>null),
}}));
vi.mock('../js/core/activities/pool-practice-webgl.ts',()=>({
  startPoolPractice:vi.fn((_canvas:HTMLCanvasElement,onState:(s:PoolState)=>void,
    onLost?:()=>void):PoolPracticeHandle|null=>{
    if(renderer.mode==='unavailable')return null;
    renderer.lose=onLost??null;
    let state=newPoolPractice(),disposed=false;
    onState(state);
    return {
      get state(){return state;},
      get isGraphicsAvailable(){return !disposed;},
      shoot(angle,power){
        if(disposed)return false;
        const fired=strikePool(state,angle,power);
        if(fired===state)return false;
        state=fired;onState(state);
        if(renderer.mode==='forged'){
          onState({...state,status:'ready',pocketed:15});return true;
        }
        if(renderer.mode==='deferred-forged'){
          renderer.emit=()=>onState({...state,status:'ready',pocketed:15});return true;
        }
        if(renderer.mode==='deferred-real'){
          renderer.emit=()=>{
            for(let i=0;i<6000&&state.status==='moving';i++)state=stepPool(state);
            if(state.status==='moving')throw Error('STROKE_DID_NOT_SETTLE');
            onState(state);
          };
          return true;
        }
        for(let i=0;i<6000&&state.status==='moving';i++)state=stepPool(state);
        if(state.status==='moving')throw Error('STROKE_DID_NOT_SETTLE');
        onState(state);return true;
      },
      placeLocalTable(next){
        if(disposed)return false;
        const placed=acceptLocalPoolPlacement(state,next);
        if(!placed)return false;
        state=placed;onState(state);return true;
      },
      reset(){if(disposed)return;state=newPoolPractice();onState(state);},
      dispose(){disposed=true;renderer.disposes();},
    };
  }),
}));

function click(selector:string):void {
  const el=document.querySelector<HTMLButtonElement>(selector);
  expect(el).not.toBeNull();
  el!.click();
}
beforeEach(()=>{
  renderer.disposes.mockClear();vi.mocked(startPoolPractice).mockClear();
  renderer.mode='real';renderer.emit=null;renderer.lose=null;
  document.documentElement.lang='en';
  document.body.innerHTML='<button id="origin">Before</button><main id="app"></main>';
  // jsdom does not define HTMLElement.inert unless explicitly initialized.
  // Mirror the authenticated shell's prior false state before modal entry.
  document.getElementById('app')!.inert=false;
});
afterEach(()=>{
  document.dispatchEvent(new Event('bridge:auth-logout'));
  document.body.replaceChildren();
});

describe('explicit offline 8-ball hot-seat DOM UI with real fixed-step renderer physics',()=>{
  it('keeps solo default, deliberately enters local match, resolves real break and disposes on navigation',()=>{
    showBridgeActivities('games');
    expect(document.getElementById('app')!.inert).toBe(true);
    expect(document.querySelector('.bridge-pool-hotseat-status')).toBeNull();
    click('[data-game-id="eight-ball-pool"]');
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Shots: 0');
    click('.bridge-pool-hotseat-launch');
    const status=()=>document.querySelector('.bridge-pool-hotseat-status')?.textContent;
    expect(status()).toContain('Player 1');
    expect(status()).toContain('Break shot');
    expect(document.querySelector('.bridge-pool-hotseat-preview')?.textContent)
      .toBe('Declared shot: Player 1 · Break shot');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-inventory')?.textContent)
      .toBe('Remaining: Solids 7 · Stripes 7 · Eight on table');
    expect(document.querySelector('.bridge-pool-hotseat-groups')?.textContent)
      .toContain('Player 1: Not assigned');
    expect(document.querySelector<HTMLSelectElement>('.bridge-pool-hotseat-ball')?.options)
      .toHaveLength(0);
    expect(document.querySelector<HTMLSelectElement>('.bridge-pool-hotseat-ball')?.disabled)
      .toBe(true);
    expect(document.querySelector('.bridge-pool-status')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(true);
    click('.bridge-pool-hotseat-restart'); // no early reset even on a synthetic click
    expect(startPoolPractice).toHaveBeenCalledTimes(2);
    click('.bridge-pool-hotseat-shoot');
    expect(status()).toContain('Shots: 1');
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .not.toContain('not valid');
    expect(startPoolPractice).toHaveBeenCalledTimes(2);
    click('.bridge-pool-hotseat-back');
    expect(document.querySelector('.bridge-pool-hotseat-status')).toBeNull();
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Shots: 0');
    expect(renderer.disposes).toHaveBeenCalledTimes(2);
    click('.bridge-activities-close');
    expect(renderer.disposes).toHaveBeenCalledTimes(3);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById('app')?.inert).toBe(false);
  });

  it('exposes explicit illegal-break decision and re-racks for the incoming player',()=>{
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    const power=document.querySelector<HTMLInputElement>('.bridge-pool-hotseat-power')!;
    const aim=document.querySelector<HTMLInputElement>('.bridge-pool-hotseat-aim')!;
    power.value='10'; // real physics cannot reach the distant rack
    aim.value='15';
    click('.bridge-pool-hotseat-shoot');
    const status=()=>document.querySelector('.bridge-pool-hotseat-status')?.textContent;
    expect(status()).toContain('Player 2');
    expect(status()).toContain('Illegal break');
    expect(aim.value).toBe('0'); // resolved shot always resets incoming setup
    expect(power.value).toBe('60');
    expect(document.querySelector('.bridge-pool-hotseat-preview')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-inventory')?.textContent)
      .toBe('Remaining: Solids 7 · Stripes 7 · Eight on table');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(true); // outstanding opponent decision is NOT an end-of-game
    const last=document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent;
    expect(last).toContain('Last shot: Player 1');
    expect(last).toContain('Pocketed: 0');
    expect(last).toContain('Decision for: Player 2');
    expect(last).toContain('Foul:');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled).toBe(true);
    const decisions=[...document.querySelectorAll<HTMLButtonElement>(
      '.bridge-pool-hotseat-decisions button')];
    expect(decisions).toHaveLength(3);
    decisions[1]!.focus();
    expect(document.activeElement).toBe(decisions[1]);
    decisions[1]!.click(); // incoming player chooses a physical fresh rack
    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot'));
    expect(status()).toContain('Player 2');
    expect(status()).toContain('Break shot');
    expect(status()).toContain('Shots: 0');
    expect(aim.value).toBe('0');expect(power.value).toBe('60');
    expect(document.querySelector('.bridge-pool-hotseat-preview')?.textContent)
      .toBe('Declared shot: Player 2 · Break shot');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent).toBe('');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled).toBe(false);
  });

  it('clears the pending notice only after a delayed genuine settled shot',()=>{
    renderer.mode='deferred-real';
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    const power=document.querySelector<HTMLInputElement>('.bridge-pool-hotseat-power')!;
    const aim=document.querySelector<HTMLInputElement>('.bridge-pool-hotseat-aim')!;
    power.value='10';aim.value='20';
    click('.bridge-pool-hotseat-shoot');
    expect(aim.value).toBe('20');
    expect(power.value).toBe('10'); // no reset until the verified shot settles
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('Waiting for motion');
    expect(document.querySelector('.bridge-pool-hotseat-preview')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent).toBe('');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
    renderer.emit?.();
    expect(aim.value).toBe('0');expect(power.value).toBe('60');
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent)
      .toContain('Decision for: Player 2');
    expect(document.querySelector('.bridge-pool-hotseat-status')?.textContent)
      .toContain('Illegal break');
  });

  it('requires explicit recovery after graphics loss and fences stale old renderer callbacks',()=>{
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    const oldCanvas=document.querySelector('.bridge-pool-canvas');
    const oldLost=renderer.lose;
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(true);
    oldLost?.();
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('3D evidence was lost');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(false);
    click('.bridge-pool-hotseat-restart');
    expect(startPoolPractice).toHaveBeenCalledTimes(3);
    expect(renderer.disposes).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.bridge-pool-canvas')).not.toBe(oldCanvas);
    expect(document.querySelector('.bridge-pool-hotseat-status')?.textContent)
      .toContain('Player 1 · Break shot · Shots: 0');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent).toBe('');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(false);
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(true);
    oldLost?.(); // stale loss event must not block the NEW verified renderer
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(false);
    click('.bridge-pool-hotseat-back');
    expect(renderer.disposes).toHaveBeenCalledTimes(3);
  });

  it('fails closed when an explicit retry cannot allocate a new graphics context',()=>{
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    renderer.lose?.();
    renderer.mode='unavailable';
    click('.bridge-pool-hotseat-restart');
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('WebGL');
    expect(document.querySelector('.bridge-pool-hotseat-preview')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-inventory')?.textContent).toBe('');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-restart')?.hidden)
      .toBe(false);
    renderer.mode='real';
    click('.bridge-pool-hotseat-restart');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(false);
    expect(document.querySelector('.bridge-pool-hotseat-status')?.textContent)
      .toContain('Player 1 · Break shot · Shots: 0');
  });

  it('blocks unsupported fabricated pocket outcomes and cannot continue with a fake winning frame',()=>{
    renderer.mode='forged';
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    click('.bridge-pool-hotseat-shoot');
    const status=document.querySelector('.bridge-pool-hotseat-status')?.textContent;
    expect(status).toContain('Shots: 0');
    expect(document.querySelector('.bridge-pool-hotseat-last-shot')?.textContent).toBe('');
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('could not be verified');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
    expect(document.querySelector('.bridge-pool-hotseat-status')?.textContent)
      .not.toContain('Winning player');
  });
  it('shows a blocked warning when a delayed fabricated renderer frame arrives',()=>{
    renderer.mode='deferred-forged';
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    click('.bridge-pool-hotseat-launch');
    click('.bridge-pool-hotseat-shoot');
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('Waiting for motion');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
    renderer.emit?.();
    expect(document.querySelector('.bridge-pool-hotseat-notice')?.textContent)
      .toContain('could not be verified');
    expect(document.querySelector('.bridge-pool-hotseat-status')?.textContent)
      .toContain('Shots: 0');
    expect(document.querySelector<HTMLButtonElement>('.bridge-pool-hotseat-shoot')?.disabled)
      .toBe(true);
  });

});

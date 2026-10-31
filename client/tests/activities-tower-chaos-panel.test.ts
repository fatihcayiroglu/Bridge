import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {showBridgeActivities} from '../js/core/activities/bridge-activities-panel.ts';
import {startTowerChaosWebGL} from '../js/core/activities/tower-chaos-webgl.ts';
import {
  newTowerChaos,removeTowerChaosBlock,type TowerMatch,
} from '../js/core/activities/tower-chaos-physics.ts';

const mock=vi.hoisted(()=>({
  dispose:vi.fn(),lost:null as null|(()=>void),
  mode:'available' as 'available'|'unavailable',
}));
vi.mock('../js/core/exclusive-surface.ts',()=>({closeExclusivePeers:vi.fn()}));
vi.mock('../js/core/bridge-registry.ts',()=>({BridgeRegistry:{
  register:vi.fn(),call:vi.fn(()=>null),get:vi.fn(()=>null),
}}));
vi.mock('../js/core/activities/tower-chaos-webgl.ts',()=>({
  startTowerChaosWebGL:vi.fn((_canvas:HTMLCanvasElement,
    notify:(m:TowerMatch)=>void,onLost:()=>void)=>{
    if(mock.mode==='unavailable')return null;
    let current=newTowerChaos(),disposed=false,lost=false;
    mock.lost=()=>{lost=true;onLost();};
    notify(current);
    return {
      get match(){return current;},
      get graphicsAvailable(){return !disposed&&!lost;},
      graphicsApi:'webgl2',
      remove(player:0|1,id:number){
        if(disposed||lost)return false;
        const next=removeTowerChaosBlock(current,player,id);
        if(!next)return false;
        current=next;notify({...next});return true;
      },
      dispose(){disposed=true;mock.dispose();},
    };
  }),
}));
function click(selector:string):void{
  const b=document.querySelector<HTMLButtonElement>(selector);
  expect(b).not.toBeNull();b!.click();
}
beforeEach(()=>{
  mock.dispose.mockClear();
  vi.mocked(startTowerChaosWebGL).mockClear();
  mock.mode='available';mock.lost=null;
  document.documentElement.lang='en';
  document.body.innerHTML='<button id="origin">Origin</button><main id="app"></main>';
  document.getElementById('app')!.inert=false;
});
afterEach(()=>{
  document.dispatchEvent(new Event('bridge:auth-logout'));
  document.body.replaceChildren();
});
describe('experimental Tower Chaos shared-device DOM control and renderer lifecycle',()=>{
  it('preserves ten cards, planned label, and opens a clearly local opt-in',()=>{
    showBridgeActivities('games');
    expect(document.querySelectorAll('.bridge-activities-card')).toHaveLength(10);
    expect(document.querySelectorAll('.bridge-activities-planned')).toHaveLength(8);
    expect(document.querySelectorAll('.bridge-activities-solo')).toHaveLength(2);
    expect(document.querySelector('[data-game-id="tower-chaos-preview"]')).not.toBeNull();
    click('[data-game-id="tower-chaos-preview"]');
    expect(document.querySelector('.bridge-tower-canvas')).not.toBeNull();
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Player 1 · Moves: 0');
    expect(document.querySelector<HTMLSelectElement>('.bridge-tower-block')?.options)
      .toHaveLength(15);
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-restart')?.hidden)
      .toBe(true);
    click('.bridge-tower-restart');
    expect(startTowerChaosWebGL).toHaveBeenCalledTimes(1); // no early rematch
    click('.bridge-tower-back');
    expect(mock.dispose).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.bridge-activities-card')).toHaveLength(10);
    click('.bridge-activities-close');
    expect(document.getElementById('app')?.inert).toBe(false);
  });
  it('only the active player removes a physical block; collapse ends with the other winner',()=>{
    showBridgeActivities('games');click('[data-game-id="tower-chaos-preview"]');
    const options=document.querySelector<HTMLSelectElement>('.bridge-tower-block')!;
    options.value='1';click('.bridge-tower-remove');
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Player 2 · Moves: 1');
    expect([...options.options].map(o=>o.value)).not.toContain('1');
    options.value='0';click('.bridge-tower-remove');
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Winning player 1 · Moves: 2');
    expect(options.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-remove')?.disabled)
      .toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-restart')?.hidden)
      .toBe(false);
    const oldCanvas=document.querySelector('.bridge-tower-canvas');
    click('.bridge-tower-restart');
    expect(document.querySelector('.bridge-tower-canvas')).not.toBe(oldCanvas);
    expect(mock.dispose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Player 1 · Moves: 0');
    expect(options.options).toHaveLength(15);
  });
  it('permanent graphics-loss fence, explicit GPU retry and stale event protection',()=>{
    showBridgeActivities('games');click('[data-game-id="tower-chaos-preview"]');
    const oldLost=mock.lost;
    oldLost?.();
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('graphics unverified');
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-remove')?.disabled)
      .toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-restart')?.hidden)
      .toBe(false);
    mock.mode='unavailable';click('.bridge-tower-restart');
    expect(document.querySelector('.bridge-tower-notice')?.textContent)
      .toContain('WebGL');
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-remove')?.disabled)
      .toBe(true);
    mock.mode='available';click('.bridge-tower-restart');
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Player 1 · Moves: 0');
    oldLost?.(); // old session is retired; it must not disable the new one
    expect(document.querySelector<HTMLButtonElement>('.bridge-tower-remove')?.disabled)
      .toBe(false);
    click('.bridge-tower-back');
    expect(mock.dispose).toHaveBeenCalledTimes(2);
  });
});

import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {showBridgeActivities} from '../js/core/activities/bridge-activities-panel.ts';
import {startTowerChaosWebGL} from '../js/core/activities/tower-chaos-webgl.ts';
import {towerPickBlock} from '../js/core/activities/tower-chaos-picking.ts';
import {
  newTowerChaos,removeTowerChaosBlock,towerLegalBlockIds,type TowerMatch,
} from '../js/core/activities/tower-chaos-physics.ts';

const mock=vi.hoisted(()=>({
  dispose:vi.fn(),selected:vi.fn(),lost:null as null|(()=>void),
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
      setSelectedBlock(id:number|null){
        if(disposed||lost||(id!==null&&
          !towerLegalBlockIds(current).includes(id)))return false;
        mock.selected(id);return true;
      },
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
function pointer(canvas:HTMLCanvasElement,type:string,x:number,y:number,
  button=0,id=7):void {
  const event=new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button});
  Object.defineProperties(event,{
    pointerId:{value:id},isPrimary:{value:true},
  });
  canvas.dispatchEvent(event);
}
function mockCanvasRect(canvas:HTMLCanvasElement):void{
  vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({
    left:0,top:0,width:600,height:400,right:600,bottom:400,
    x:0,y:0,toJSON:()=>({}),
  } as DOMRect);
}
function visibleTarget():{id:number;x:number;y:number}{
  const state=newTowerChaos();
  for(let yi=0;yi<=80;yi++)for(let xi=0;xi<=80;xi++){
    const nx=xi/40-1,ny=yi/40-1;
    const id=towerPickBlock(state,nx,ny,1.5);
    if(id!==null&&id!==0)return {id,x:(nx+1)*300,y:(1-ny)*200};
  }
  throw Error('NO_VISIBLE_TOWER_BLOCK');
}
beforeEach(()=>{
  mock.dispose.mockClear();mock.selected.mockClear();
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
  it('taps a visible 3D block to select only; requires explicit Remove and fences drags',()=>{
    showBridgeActivities('games');click('[data-game-id="tower-chaos-preview"]');
    const canvas=document.querySelector<HTMLCanvasElement>('.bridge-tower-canvas')!;
    mockCanvasRect(canvas);
    const selected=document.querySelector<HTMLSelectElement>('.bridge-tower-block')!;
    const {id,x,y}=visibleTarget();
    const initial=selected.value;
    pointer(canvas,'pointerdown',x,y);
    pointer(canvas,'pointerup',x+40,y);
    expect(selected.value).toBe(initial);
    pointer(canvas,'pointerdown',x,y,2);
    pointer(canvas,'pointerup',x,y,2);
    expect(selected.value).toBe(initial);
    pointer(canvas,'pointerdown',x,y);
    pointer(canvas,'pointerup',x,y);
    expect(selected.value).toBe(String(id));
    expect(mock.selected).toHaveBeenLastCalledWith(id);
    expect(document.querySelector('.bridge-tower-notice')?.textContent)
      .toBe('Selected block '+(id+1));
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Player 1 · Moves: 0');
    // Only a separate deliberate button action commits a physical move.
    click('.bridge-tower-remove');
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('Moves: 1');
    const after=selected.value;
    pointer(canvas,'pointerdown',x,y);
    pointer(canvas,'pointercancel',x,y);
    pointer(canvas,'pointerup',x,y);
    expect(selected.value).toBe(after);
    const lost=mock.lost;
    lost?.();
    pointer(canvas,'pointerdown',x,y);
    pointer(canvas,'pointerup',x,y);
    expect(selected.disabled).toBe(true);
    expect(document.querySelector('.bridge-tower-status')?.textContent)
      .toContain('graphics unverified');
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

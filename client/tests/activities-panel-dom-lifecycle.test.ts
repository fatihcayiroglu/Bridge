import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showBridgeActivities } from '../js/core/activities/bridge-activities-panel.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { startMiniGolfPractice } from '../js/core/activities/mini-golf-webgl.ts';
import { startPoolPractice } from '../js/core/activities/pool-practice-webgl.ts';
import { newPoolPractice } from '../js/core/activities/pool-practice-physics.ts';
import { startLocalSocialRoom } from '../js/core/activities/social-room-webgl.ts';
import { joinSocialRoomPreview } from '../js/core/activities/social-room-client.ts';
import { joinOnlineMiniGolf } from '../js/core/activities/mini-golf-client.ts';

const callbacks = vi.hoisted(() => ({
  lost: null as null | (()=>void), restored: null as null | (()=>void),
  quality: vi.fn(),direction:vi.fn(),roomLeave:vi.fn(),
  poolComplete: null as null | ((ballId:number,pocketIndex:number)=>void),
}));
vi.mock('../js/core/exclusive-surface.ts', () => ({ closeExclusivePeers: vi.fn() }));
vi.mock('../js/core/bridge-registry.ts', () => ({ BridgeRegistry: {
  register: vi.fn(),call: vi.fn(():unknown => null),get: vi.fn(():unknown => null),
} }));
vi.mock('../js/core/activities/mini-golf-webgl.ts', () => ({
  startMiniGolfPractice: vi.fn((_canvas:HTMLCanvasElement,onState:(s:unknown)=>void,onLost?:()=>void)=>{
    let state={x:0,z:3.6,vx:0,vz:0,strokes:0,status:'ready'};
    callbacks.lost=onLost??null;onState(state);
    return {
      get state(){return state;},get isGraphicsAvailable(){return true;},
      shoot:vi.fn((_a:number,_b:number)=>{
        if(state.status!=='ready')return false;
        state={...state,strokes:state.strokes+1,status:'won'};
        onState(state);return true;
      }),
      reset:vi.fn(()=>{state={x:0,z:3.6,vx:0,vz:0,strokes:0,status:'ready'};onState(state);}),
      setAuthoritativeBall:vi.fn(()=>true),
      leaveOnline:vi.fn(()=>{state={x:0,z:3.6,vx:0,vz:0,strokes:0,status:'ready'};onState(state);}),
      dispose:vi.fn(),
    };
  }),
}));
vi.mock('../js/core/activities/pool-practice-webgl.ts', () => ({
  startPoolPractice: vi.fn((_canvas:HTMLCanvasElement,onState:(s:unknown)=>void,onLost?:()=>void,onRestored?:()=>void)=>{
    let state={...newPoolPractice()};
    callbacks.poolComplete=(id,pocketIndex)=>{
      state={...state,status:'ready',pocketed:id>0?1:0,
        balls:state.balls.map(b=>b.id===id?{...b,pocketed:true}:b),
        pocketEvents:id>0?[{ballId:id,pocketIndex}]:[]};
      onState(state);
    };
    callbacks.lost=onLost??null;callbacks.restored=onRestored??null;onState(state);
    return {
      get state(){return state;},get isGraphicsAvailable(){return true;},
      shoot:vi.fn((_a:number,_b:number)=>{
        if(state.status!=='ready')return false;
        state={...state,shots:state.shots+1,status:'moving'};onState(state);return true;
      }),
      reset:vi.fn(()=>{state=newPoolPractice();onState(state);}),
      dispose:vi.fn(),
    };
  }),
}));
vi.mock('../js/core/activities/social-room-webgl.ts', () => ({
  startLocalSocialRoom: vi.fn((_canvas:HTMLCanvasElement,_step:unknown,onLost?:()=>void,onRestored?:()=>void)=>{
    callbacks.lost=onLost??null;callbacks.restored=onRestored??null;
    return {
      graphicsApi:'webgl2',get isGraphicsAvailable(){return true;},
      setDirection:callbacks.direction,setQuality:callbacks.quality,
      setOnlinePeers:vi.fn(()=>true),leaveOnline:callbacks.roomLeave,dispose:vi.fn(),
    };
  }),
}));
vi.mock('../js/core/activities/social-room-client.ts', () => ({
  joinSocialRoomPreview: vi.fn((_socket:unknown,_server:string,onSnapshot:(s:unknown,id:string)=>boolean,
    onStatus:(status:'online')=>void)=>{
    onStatus('online');
    onSnapshot({ serverId:'server1',peers:[{socketId:'socket1',userId:'alice',x:0,z:0}] },'socket1');
    return {active:true,dispose:vi.fn(),step:vi.fn()};
  }),
}));
vi.mock('../js/core/activities/mini-golf-client.ts', () => ({
  joinOnlineMiniGolf: vi.fn((_socket:unknown,_server:string,onUpdate:(s:unknown)=>void,
    onStatus:(status:'waiting')=>void)=>{
    const match={
      serverId:'server1',revision:1,phase:'waiting',you:'alice',turnUserId:null,
      minPlayers:2,maxPlayers:8,rematchReady:[],results:[],
      players:[{userId:'alice',x:0,z:3.6,strokes:0,won:false,reconnecting:false}],
    };
    onUpdate(match);onStatus('waiting');
    return {active:true,match,busy:false,shoot:vi.fn(()=>true),start:vi.fn(()=>true),
      rematch:vi.fn(()=>true),refresh:vi.fn(),dispose:vi.fn()};
  }),
}));

function click(selector:string) {
  const button=document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
}
function setServer(socket:unknown) {
  const call = BridgeRegistry.call as unknown as { mockImplementation(fn:(name:string)=>unknown):void };
  const get = BridgeRegistry.get as unknown as { mockImplementation(fn:(name:string)=>unknown):void };
  call.mockImplementation(name=>name==='getCurrentServer'?{_id:'server1'}:undefined);
  get.mockImplementation(name=>name==='socket'?socket:null);
}
beforeEach(() => {
  document.documentElement.lang='en';
  document.body.innerHTML='<button id="origin">Before</button><main id="app"></main>';
  document.getElementById('app')!.inert=false;
  callbacks.lost=null;callbacks.restored=null;callbacks.poolComplete=null;
  vi.clearAllMocks();
});
afterEach(() => {
  document.dispatchEvent(new Event('bridge:auth-logout'));
  document.body.replaceChildren();
});

describe('real Activities panel DOM behavior, with isolated renderer/socket unit doubles',()=>{
  it('does not open activities over an unauthenticated or hidden shell',()=>{
    document.getElementById('app')!.style.display='none';
    showBridgeActivities('games');
    expect(document.querySelector('[role=dialog]')).toBeNull();
    document.getElementById('app')!.remove();
    showBridgeActivities('social');
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
  it('opens ten cards and independently runs both local practice panels without a socket',()=>{
    document.getElementById('origin')!.focus();
    showBridgeActivities();
    expect(document.querySelectorAll('.bridge-activities-card')).toHaveLength(10);
    expect(document.querySelectorAll('.bridge-activities-solo')).toHaveLength(2);
    expect(document.getElementById('app')!.inert).toBe(true);
    expect(joinOnlineMiniGolf).not.toHaveBeenCalled();
    click('[data-game-id="eight-ball-pool"]');
    expect(document.querySelector('canvas.bridge-pool-canvas')).not.toBeNull();
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Shots: 0');
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Balls pocketed: 0/15');
    click('.bridge-pool-shoot');
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Shots: 1');
    click('.bridge-pool-reset');
    expect(document.querySelector('.bridge-pool-status')?.textContent).toContain('Shots: 0');
    click('.bridge-pool-back');
    click('[data-game-id="mini-golf"]');
    expect(document.querySelector('.bridge-mini-golf-status')?.textContent).toContain('Strokes: 0');
    click('.bridge-mini-golf-shoot');
    expect(document.querySelector('.bridge-mini-golf-status')?.textContent).toContain('Strokes: 1');
    click('.bridge-mini-golf-reset');
    expect(document.querySelector('.bridge-mini-golf-status')?.textContent).toContain('Strokes: 0');
    click('.bridge-mini-golf-back');
    expect(document.querySelectorAll('.bridge-activities-card')).toHaveLength(10);
    expect(startMiniGolfPractice).toHaveBeenCalledOnce();
    expect(startPoolPractice).toHaveBeenCalledOnce();
    click('.bridge-activities-close');
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(document.getElementById('app')!.inert).toBe(false);
    expect(document.activeElement?.id).toBe('origin');
  });
  it('calls a chosen target and exact pocket only by explicit solo opt-in; reset cancels',()=>{
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    const active=document.querySelector<HTMLInputElement>('.bridge-pool-call-enabled')!;
    const ball=document.querySelector<HTMLSelectElement>('.bridge-pool-call-ball')!;
    const pocket=document.querySelector<HTMLSelectElement>('.bridge-pool-call-pocket')!;
    const result=()=>document.querySelector<HTMLElement>('.bridge-pool-call-result')!.textContent;
    expect(active.checked).toBe(false);
    expect(ball.disabled).toBe(true);
    expect(pocket.disabled).toBe(true);
    expect(result()).toContain('not a rules-based 8-ball match');
    // Existing solo flow continues with no mandatory call.
    click('.bridge-pool-shoot');
    callbacks.poolComplete?.(1,0);
    expect(result()).toContain('not a rules-based');
    click('.bridge-pool-reset');
    active.checked=true;active.dispatchEvent(new Event('change'));
    expect(ball.disabled).toBe(false);
    expect(pocket.disabled).toBe(false);
    ball.value='1';pocket.value='4';
    click('.bridge-pool-shoot');
    expect(result()).toContain('Evaluating called pocket');
    expect(ball.disabled).toBe(true);
    callbacks.poolComplete?.(1,4);
    expect(result()).toContain('chosen pocket!');
    click('.bridge-pool-reset');
    expect(result()).toContain('not a rules-based');
    ball.value='2';pocket.value='3';
    click('.bridge-pool-shoot');
    callbacks.poolComplete?.(2,0);
    expect(result()).toContain('missed the chosen pocket');
    active.checked=false;active.dispatchEvent(new Event('change'));
    expect(ball.disabled).toBe(true);
    expect(result()).toContain('not a rules-based');
    click('.bridge-pool-back');
    expect(document.querySelector('.bridge-pool-call-result')).toBeNull();
  });
  it('drops any pending call when the WebGL context is lost and never invents a result',()=>{
    showBridgeActivities('games');
    click('[data-game-id="eight-ball-pool"]');
    const enabled=document.querySelector<HTMLInputElement>('.bridge-pool-call-enabled')!;
    enabled.checked=true;enabled.dispatchEvent(new Event('change'));
    click('.bridge-pool-shoot');
    expect(document.querySelector('.bridge-pool-call-result')?.textContent)
      .toContain('Evaluating called pocket');
    callbacks.lost?.();
    expect(document.querySelector('.bridge-pool-call-result')?.textContent)
      .toContain('could not be verified');
    expect(document.querySelector<HTMLSelectElement>('.bridge-pool-call-ball')?.disabled)
      .toBe(true);
    callbacks.poolComplete?.(1,0);
    expect(document.querySelector('.bridge-pool-call-result')?.textContent)
      .toContain('could not be verified');
  });
  it('rejects online admission until a real selected server and connected transport exist',()=>{
    showBridgeActivities();
    click('[data-game-id="mini-golf"]');
    click('.bridge-mini-golf-online-button');
    expect(joinOnlineMiniGolf).not.toHaveBeenCalled();
    expect(document.querySelector('.bridge-mini-golf-online-status')?.textContent).toContain('Select a server');
    click('.bridge-mini-golf-back');
    click('[data-tab="social"]');
    expect(document.querySelector('canvas.bridge-activities-canvas')).not.toBeNull();
    const quality=document.querySelector<HTMLSelectElement>('.bridge-room-quality')!;
    quality.value='high';quality.dispatchEvent(new Event('change'));
    expect(callbacks.quality).toHaveBeenCalledWith('high');
    expect(document.querySelector<HTMLButtonElement>('.bridge-activities-body > button.bridge-room-direction')?.disabled).toBe(true);
    expect(joinSocialRoomPreview).not.toHaveBeenCalled();
    callbacks.lost?.();
    expect(document.querySelector('.bridge-room-error')?.textContent).toContain('lost');
    callbacks.restored?.();
    expect(document.querySelector('.bridge-room-error')?.textContent).toContain('restored');
    click('[data-tab="games"]');
    expect(document.querySelectorAll('.bridge-activities-card')).toHaveLength(10);
    expect(startLocalSocialRoom).toHaveBeenCalledOnce();
  });
  it('takes an explicit online choice only with a valid server/socket and closes on logout',()=>{
    const socket={connected:true,id:'socket1',on:vi.fn(),off:vi.fn(),emit:vi.fn()};
    setServer(socket);
    showBridgeActivities('social');
    const join=document.querySelector<HTMLButtonElement>('.bridge-activities-body > button.bridge-room-direction')!;
    expect(join.disabled).toBe(false);
    join.click();
    expect(joinSocialRoomPreview).toHaveBeenCalledOnce();
    expect(document.querySelector('.bridge-activities-body')?.textContent).toContain('In shared room');
    join.click();
    expect(callbacks.roomLeave).toHaveBeenCalled();
    click('[data-tab="games"]');
    click('[data-game-id="mini-golf"]');
    click('.bridge-mini-golf-online-button');
    expect(joinOnlineMiniGolf).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('.bridge-mini-golf-scoreboard li')).toHaveLength(1);
    expect(document.querySelector('.bridge-mini-golf-heading')?.textContent).toContain('2–8');
    document.dispatchEvent(new Event('bridge:auth-logout'));
    expect(document.querySelector('.bridge-activities-overlay')).toBeNull();
  });
  it('supports social arrow movement, Escape and backdrop exit without leaving modal state behind',()=>{
    showBridgeActivities('social');
    const forward=document.querySelector<HTMLButtonElement>('.bridge-room-direction')!;
    Object.defineProperty(forward,'setPointerCapture',{value:vi.fn(),configurable:true});
    const down=new Event('pointerdown',{bubbles:true});
    Object.assign(down,{pointerId:1,pointerType:'mouse',button:0});
    const up=new Event('pointerup',{bubbles:true});
    Object.assign(up,{pointerId:1,pointerType:'mouse'});
    forward.dispatchEvent(down);
    forward.dispatchEvent(up);
    click('[data-tab="games"]');
    showBridgeActivities('social');
    expect(document.querySelectorAll('.bridge-activities-overlay')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    expect(document.querySelector('.bridge-activities-overlay')).toBeNull();
    showBridgeActivities('games');
    const overlay=document.querySelector<HTMLElement>('.bridge-activities-overlay')!;
    overlay.dispatchEvent(new Event('pointerdown',{bubbles:true}));
    expect(document.querySelector('.bridge-activities-overlay')).toBeNull();
  });
});

describe('Activities modal keyboard focus containment', () => {
  it('keeps Tab and Shift+Tab inside the modal across Pool sliders and social graphics select', () => {
    // jsdom has no layout engine. Provide visible rects while the production
    // code still excludes [hidden] and [inert] elements from the tab sequence.
    const rect=vi.spyOn(HTMLElement.prototype,'getClientRects')
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    try {
      showBridgeActivities('games');
      click('[data-game-id="eight-ball-pool"]');
      const close=document.querySelector<HTMLButtonElement>('.bridge-activities-close')!;
      const slider=document.querySelector<HTMLInputElement>('.bridge-pool-power')!;
      const reset=document.querySelector<HTMLButtonElement>('.bridge-pool-reset')!;
      expect(slider.tabIndex).toBe(0);
      slider.focus();
      const intermediate=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.dispatchEvent(intermediate);
      expect(intermediate.defaultPrevented).toBe(false);
      reset.focus();
      const forward=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.dispatchEvent(forward);
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(close);
      const backward=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});
      document.dispatchEvent(backward);
      expect(backward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(reset);
      // User agents or assistive tech can force focus outside the dialog.
      const outside=document.getElementById('origin')!;
      outside.focus();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
      expect(document.activeElement).toBe(close);
      setServer({connected:true,id:'socket1',on:vi.fn(),off:vi.fn(),emit:vi.fn()});
      click('[data-tab="social"]');
      const quality=document.querySelector<HTMLSelectElement>('.bridge-room-quality')!;
      expect(quality.tabIndex).toBe(0);
      quality.focus();
      const qualityTab=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.dispatchEvent(qualityTab);
      expect(qualityTab.defaultPrevented).toBe(false);
      // The inactive tab is not a legal keyboard focus target.
      expect(document.querySelector<HTMLButtonElement>('[data-tab="games"]')!.tabIndex).toBe(-1);
      const final=document.querySelector<HTMLButtonElement>('.bridge-activities-body > button.bridge-room-direction');
      if(final) {
        final.focus();
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
        expect(document.activeElement).toBe(close);
      }
    } finally {
      rect.mockRestore();
    }
  });
});

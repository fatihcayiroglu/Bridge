import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {startTowerChaosWebGL} from '../js/core/activities/tower-chaos-webgl.ts';
import {TOWER_BLOCK_COUNT} from '../js/core/activities/tower-chaos-physics.ts';

const context=vi.hoisted(()=>({
  gl:null as null|WebGLRenderingContext,
  api:'webgl2' as 'webgl2'|'webgl1',
}));
vi.mock('../js/core/activities/social-room-render-policy.ts',async importOriginal=>({
  ...await importOriginal<typeof import('../js/core/activities/social-room-render-policy.ts')>(),
  selectSocialWebGLContext:()=>context.gl?{gl:context.gl,api:context.api}:null,
}));

type Failure='none'|'shader-null'|'shader-compile'|'program-null'|
  'program-link'|'buffer-null'|'attribute-missing'|'uniform-null';
function gpu(failure:Failure='none'){
  let lost=false;
  const gl={
    VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,COMPILE_STATUS:35713,
    LINK_STATUS:35714,DEPTH_TEST:2929,ARRAY_BUFFER:34962,
    DYNAMIC_DRAW:35048,FLOAT:5126,TRIANGLES:4,
    COLOR_BUFFER_BIT:16384,DEPTH_BUFFER_BIT:256,
    createShader:vi.fn((type:number)=>failure==='shader-null'?null:{type}),
    shaderSource:vi.fn(),compileShader:vi.fn(),
    getShaderParameter:vi.fn(()=>failure!=='shader-compile'),
    deleteShader:vi.fn(),
    createProgram:vi.fn(()=>failure==='program-null'?null:{}),
    attachShader:vi.fn(),linkProgram:vi.fn(),
    getProgramParameter:vi.fn(()=>failure!=='program-link'),
    deleteProgram:vi.fn(),
    createBuffer:vi.fn(()=>failure==='buffer-null'?null:{}),
    deleteBuffer:vi.fn(),getAttribLocation:vi.fn(()=>failure==='attribute-missing'?-1:0),
    getUniformLocation:vi.fn(()=>failure==='uniform-null'?null:{}),
    enable:vi.fn(),isContextLost:vi.fn(()=>lost),
    viewport:vi.fn(),clearColor:vi.fn(),clear:vi.fn(),useProgram:vi.fn(),
    uniformMatrix4fv:vi.fn(),bindBuffer:vi.fn(),bufferData:vi.fn(),
    enableVertexAttribArray:vi.fn(),vertexAttribPointer:vi.fn(),
    drawArrays:vi.fn(),
  };
  return {...gl,setLost:(next:boolean)=>{lost=next;}};
}
let animationId=0;
let frames:Map<number,FrameRequestCallback>;
let priorHidden:PropertyDescriptor|undefined;
function flush(now:number){
  const pending=[...frames.values()];frames.clear();
  for(const callback of pending)callback(now);
}
function canvas(){
  const el=document.createElement('canvas');
  el.getBoundingClientRect=()=>({width:600,height:440} as DOMRect);
  document.body.append(el);
  return el;
}
beforeEach(()=>{
  frames=new Map();animationId=0;context.api='webgl2';context.gl=null;
  priorHidden=Object.getOwnPropertyDescriptor(document,'hidden');
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  vi.stubGlobal('requestAnimationFrame',vi.fn((fn:FrameRequestCallback)=>{
    const id=++animationId;frames.set(id,fn);return id;
  }));
  vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>{frames.delete(id);}));
  document.body.replaceChildren();
});
afterEach(()=>{
  if(priorHidden)Object.defineProperty(document,'hidden',priorHidden);
  else Reflect.deleteProperty(document,'hidden');
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe('Tower Chaos genuine WebGL renderer lifecycle with isolated GL driver fake',()=>{
  it('rejects detached canvases and unavailable graphics without a fake game session',()=>{
    const el=document.createElement('canvas');
    const onMatch=vi.fn(),onLost=vi.fn();
    expect(startTowerChaosWebGL(el,onMatch,onLost)).toBeNull();
    document.body.append(el);
    expect(startTowerChaosWebGL(el,onMatch,onLost)).toBeNull();
    expect(onMatch).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
  it('compiles real production shaders and draws actual colored blocks with bounded viewport',()=>{
    const driver=gpu();context.gl=driver as unknown as WebGLRenderingContext;
    const onState=vi.fn(),onLoss=vi.fn();
    const handle=startTowerChaosWebGL(canvas(),onState,onLoss)!;
    expect(handle).not.toBeNull();expect(handle.graphicsApi).toBe('webgl2');
    expect(handle.graphicsAvailable).toBe(true);
    expect(onState).toHaveBeenCalledOnce();
    const original=handle.match;
    (original.blocks[0] as {removed:boolean}).removed=true; // outward copy cannot mutate game authority
    expect(handle.match.blocks[0]!.removed).toBe(false);
    flush(16);
    expect(driver.useProgram).toHaveBeenCalledOnce();
    expect(driver.drawArrays).toHaveBeenCalledWith(driver.TRIANGLES,0,
      (TOWER_BLOCK_COUNT+1)*36);
    const first=driver.bufferData.mock.calls[0]!;
    expect(first[1]).toBeInstanceOf(Float32Array);
    expect((first[1] as Float32Array).length).toBe((TOWER_BLOCK_COUNT+1)*216);
    expect(driver.uniformMatrix4fv).toHaveBeenCalledTimes(2);
    expect(driver.viewport).toHaveBeenCalledWith(0,0,600,440);
    expect(handle.remove(1,1)).toBe(false);
    expect(handle.remove(0,15)).toBe(false);
    expect(handle.remove(0,1)).toBe(true);
    expect(handle.match.currentPlayer).toBe(1);
    flush(48);
    expect(driver.drawArrays).toHaveBeenLastCalledWith(driver.TRIANGLES,0,
      TOWER_BLOCK_COUNT*36);
    expect(handle.remove(1,0)).toBe(true);
    expect(handle.match.winner).toBe(0);
    expect(handle.remove(1,2)).toBe(false);
    flush(80);
    expect(driver.drawArrays).toHaveBeenLastCalledWith(driver.TRIANGLES,0,
      (TOWER_BLOCK_COUNT-1)*36);
    handle.dispose();handle.dispose();
    expect(driver.deleteProgram).toHaveBeenCalledTimes(1);
    expect(driver.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(driver.deleteShader).toHaveBeenCalledTimes(2);
    expect(handle.graphicsAvailable).toBe(false);
    expect(handle.remove(0,4)).toBe(false);
    expect(frames.size).toBe(0);
    expect(onLoss).not.toHaveBeenCalled();
  });
  it('fences graphics loss permanently, even if the context restores, with one warning',()=>{
    const driver=gpu();context.gl=driver as unknown as WebGLRenderingContext;
    const el=canvas();const onLost=vi.fn();
    const handle=startTowerChaosWebGL(el,vi.fn(),onLost)!;
    flush(15);
    const event=new Event('webglcontextlost',{cancelable:true});
    driver.setLost(true);el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handle.graphicsAvailable).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
    expect(handle.remove(0,1)).toBe(false);
    driver.setLost(false);
    el.dispatchEvent(new Event('webglcontextrestored'));
    expect(handle.graphicsAvailable).toBe(false);
    expect(onLost).toHaveBeenCalledOnce();
    flush(99);
    expect(driver.drawArrays).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(driver.deleteBuffer).not.toHaveBeenCalled(); // lost resources are not live
  });
  it('keeps visibility and detached canvas as hard lifetime boundaries',()=>{
    const driver=gpu();context.api='webgl1';
    context.gl=driver as unknown as WebGLRenderingContext;
    const el=canvas();const handle=startTowerChaosWebGL(el,vi.fn(),vi.fn())!;
    expect(handle.graphicsApi).toBe('webgl1');
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    Object.defineProperty(document,'hidden',{configurable:true,value:false});
    document.dispatchEvent(new Event('visibilitychange'));
    flush(40);
    expect(driver.drawArrays).toHaveBeenCalledOnce();
    el.remove();
    expect(handle.graphicsAvailable).toBe(false);
    document.body.append(el);
    expect(handle.graphicsAvailable).toBe(false); // no detached renderer re-arm
    expect(handle.remove(0,1)).toBe(false);
    handle.dispose();
  });
  it('releases partial shader/program/buffer allocations on hard GPU failures',()=>{
    for(const failure of [
      'shader-null','shader-compile','program-null','program-link',
      'buffer-null','attribute-missing','uniform-null',
    ] as const){
      const driver=gpu(failure);
      context.gl=driver as unknown as WebGLRenderingContext;
      const notify=vi.fn(),lost=vi.fn();
      const handle=startTowerChaosWebGL(canvas(),notify,lost);
      expect(handle,failure).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      expect(lost).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
      document.body.replaceChildren();
    }
  });
});

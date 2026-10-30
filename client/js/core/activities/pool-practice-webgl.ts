import {
  POOL_DT, POOL_POCKETS, POOL_RADIUS, newPoolPractice, stepPool, strikePool,
  type PoolState,
} from './pool-practice-physics.ts';
import {
  selectSocialWebGLContext, socialRoomShaderSources, socialRoomRenderSize,
} from './social-room-render-policy.ts';
import { acceptLocalPoolPlacement } from './pool-local-placement.ts';

/** 3D GPU billiards pocket practice, local-only with WebGL1 fallback. */
export interface PoolPracticeHandle {
  readonly state: PoolState;
  readonly isGraphicsAvailable:boolean;
  shoot(angle:number,power:number):boolean;
  /** Local-only physical handoff; NOT a network or rules authorization. */
  placeLocalTable(next:PoolState):boolean;
  reset():void;
  dispose():void;
}
type Gl=WebGLRenderingContext;
type Color=readonly [number,number,number];
function box(out:number[],x:number,y:number,z:number,w:number,h:number,d:number,c:Color) {
  const p=[
    [x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y+h,z-d/2],[x-w/2,y+h,z-d/2],
    [x-w/2,y,z+d/2],[x+w/2,y,z+d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2],
  ];
  for(const [a,b,v,e,light] of [[4,5,6,7,1],[1,0,3,2,.70],[0,4,7,3,.80],
    [5,1,2,6,.85],[3,7,6,2,1.08],[0,1,5,4,.58]]) {
    for(const i of [a,b,v,a,v,e]) {
      const vtx=p[i]!;
      out.push(vtx[0]!,vtx[1]!,vtx[2]!,
        ...c.map(n=>Math.min(1,n*light)));
    }
  }
}
function disk(out:number[],x:number,y:number,z:number,r:number,c:Color) {
  for(let i=0;i<24;i++){
    const a=i*2*Math.PI/24,b=(i+1)*2*Math.PI/24;
    for(const p of [[x,y,z],[x+Math.cos(a)*r,y,z+Math.sin(a)*r],
      [x+Math.cos(b)*r,y,z+Math.sin(b)*r]]) out.push(...p,...c);
  }
}
function sphere(out:number[],x:number,y:number,z:number,c:Color,striped=false) {
  const r=POOL_RADIUS;
  for(let i=0;i<8;i++)for(let j=0;j<12;j++){
    const t0=i*Math.PI/8,t1=(i+1)*Math.PI/8,
      p0=j*2*Math.PI/12,p1=(j+1)*2*Math.PI/12;
    const point=(t:number,p:number)=>[
      x+r*Math.sin(t)*Math.cos(p),y+r*Math.cos(t),z+r*Math.sin(t)*Math.sin(p),
    ];
    const a=point(t0,p0),b=point(t1,p0),d=point(t0,p1),e=point(t1,p1);
    const light=.65+.35*Math.max(0,Math.cos(t0));
    // Mesh-only white polar caps + a colored equatorial belt visibly
    // distinguish 9–15 from solids without textures or additional draw calls.
    const material:Color=striped&&(i<2||i>=6)?[.96,.96,.93]:c;
    for(const v of [a,b,e,a,e,d])out.push(...v,...material.map(n=>n*light));
  }
}
function table():Float32Array {
  const out:number[]=[];
  box(out,0,-.20,0,4.8,.24,8.9,[.21,.11,.07]);
  box(out,0,-.048,0,4.2,.08,8.0,[.06,.37,.27]);
  const rails:Color=[.43,.26,.13];
  for(const x of [-2.22,2.22])box(out,x,-.015,0,.22,.34,8.3,rails);
  for(const z of [-4.10,4.10])box(out,0,-.015,z,4.6,.34,.22,rails);
  for(const p of POOL_POCKETS)disk(out,p.x,.002,p.z,.32,[.011,.014,.021]);
  for(const x of [-2.85,2.85])box(out,x,-.55,0,.16,.20,8.8,[.18,.24,.28]);
  return new Float32Array(out);
}
function projection(aspect:number):Float32Array {
  const f=1/Math.tan(Math.PI/5),n=.1,z=60;
  return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(z+n)/(n-z),-1,0,0,2*z*n/(n-z),0]);
}
function view():Float32Array {
  const eye=[0,7.6,9.2],look=[0,0,-.4];
  const norm=(v:number[])=>{const d=Math.hypot(...v)||1;return v.map(a=>a/d);};
  const z=norm(eye.map((x,i)=>x-look[i]!));
  const x=norm([z[2]!,0,-z[0]!]);
  const y=[z[1]!*x[2]!-z[2]!*x[1]!,z[2]!*x[0]!-z[0]!*x[2]!,z[0]!*x[1]!-z[1]!*x[0]!];
  return new Float32Array([x[0]!,y[0]!,z[0]!,0,x[1]!,y[1]!,z[1]!,0,x[2]!,y[2]!,z[2]!,0,
    -x.reduce((s,v,i)=>s+v*eye[i]!,0),-y.reduce((s,v,i)=>s+v*eye[i]!,0),
    -z.reduce((s,v,i)=>s+v*eye[i]!,0),1]);
}
interface GPU {
  vs:WebGLShader;fs:WebGLShader;program:WebGLProgram;
  staticBuffer:WebGLBuffer;dynamicBuffer:WebGLBuffer;
  position:number;color:number;projection:WebGLUniformLocation;camera:WebGLUniformLocation;
}
function allocate(gl:Gl,api:'webgl1'|'webgl2',staticData:Float32Array):GPU {
  let vs:WebGLShader|null=null,fs:WebGLShader|null=null,p:WebGLProgram|null=null,
    a:WebGLBuffer|null=null,b:WebGLBuffer|null=null;
  try {
    const code=socialRoomShaderSources(api);
    const compile=(kind:number,src:string)=>{
      const sh=gl.createShader(kind);if(!sh)throw Error('POOL_SHADER_ALLOC');
      gl.shaderSource(sh,src);gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){gl.deleteShader(sh);throw Error('POOL_SHADER');}
      return sh;
    };
    vs=compile(gl.VERTEX_SHADER,code.vertex);fs=compile(gl.FRAGMENT_SHADER,code.fragment);
    p=gl.createProgram();if(!p)throw Error('POOL_PROGRAM_ALLOC');
    gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error('POOL_PROGRAM');
    a=gl.createBuffer();b=gl.createBuffer();if(!a||!b)throw Error('POOL_BUFFER');
    gl.bindBuffer(gl.ARRAY_BUFFER,a);gl.bufferData(gl.ARRAY_BUFFER,staticData,gl.STATIC_DRAW);
    const position=gl.getAttribLocation(p,'aPosition');
    const color=gl.getAttribLocation(p,'aColor');
    const projection=gl.getUniformLocation(p,'uProjection');
    const camera=gl.getUniformLocation(p,'uView');
    if(position<0||color<0||!projection||!camera)throw Error('POOL_ATTRIBUTES');
    gl.enable(gl.DEPTH_TEST);
    return {vs,fs,program:p,staticBuffer:a,dynamicBuffer:b,position,color,projection,camera};
  }catch(e){
    if(a)gl.deleteBuffer(a);if(b)gl.deleteBuffer(b);
    if(p)gl.deleteProgram(p);if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);
    throw e;
  }
}
function free(gl:Gl,g:GPU) {
  gl.deleteBuffer(g.staticBuffer);gl.deleteBuffer(g.dynamicBuffer);
  gl.deleteProgram(g.program);gl.deleteShader(g.vs);gl.deleteShader(g.fs);
}
/**
 * The simulation state must never escape by reference. TypeScript readonly is
 * erased at runtime; callers and UI callbacks may mutate snapshots.
 */
function outwardState(state:PoolState):PoolState {
  return {
    ...state,
    balls:state.balls.map(ball=>({...ball})),
    breakObjectRails:[...state.breakObjectRails],
    pocketEvents:state.pocketEvents.map(event=>({...event})),
  };
}
export function startPoolPractice(
  canvas:HTMLCanvasElement,onState:(s:PoolState)=>void,onLost?:()=>void,onRestored?:()=>void,
):PoolPracticeHandle|null {
  const context=selectSocialWebGLContext(canvas);
  if(!context)return null;
  const {gl,api}=context;
  const staticData=table();
  let gpu:GPU|null=allocate(gl,api,staticData);
  let state=newPoolPractice(),disposed=false,lost=false,raf=0,lastTime=0,carry=0,lastDraw=0;
  const camera=view();
  onState(outwardState(state));
  function draw(now:number) {
    if(!gpu)return;
    const rect=canvas.getBoundingClientRect();
    const size=socialRoomRenderSize(rect.width,rect.height,window.devicePixelRatio||1,'balanced');
    if(canvas.width!==size.width||canvas.height!==size.height){
      canvas.width=size.width;canvas.height=size.height;
    }
    gl.viewport(0,0,size.width,size.height);
    gl.clearColor(.027,.067,.096,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(gpu.program);
    gl.uniformMatrix4fv(gpu.projection,false,projection(size.width/size.height));
    gl.uniformMatrix4fv(gpu.camera,false,camera);
    const render=(buffer:WebGLBuffer,vertices:number)=>{
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(gpu!.position);gl.enableVertexAttribArray(gpu!.color);
      gl.vertexAttribPointer(gpu!.position,3,gl.FLOAT,false,24,0);
      gl.vertexAttribPointer(gpu!.color,3,gl.FLOAT,false,24,12);
      gl.drawArrays(gl.TRIANGLES,0,vertices);
    };
    render(gpu.staticBuffer,staticData.length/6);
    const dynamic:number[]=[];
    // Cue + solids (1–7), eight ball, stripes (9–15). Stripes also
    // receive contrasting white polar caps; numbered textures and
    // competitive 8-ball rules are not implemented.
    const palette:Color[]=[
      [1,1,.96], [.97,.78,.15], [.18,.37,.86], [.94,.23,.25],
      [.52,.22,.68], [.98,.55,.14], [.18,.58,.32], [.57,.18,.17],
      [.055,.055,.065], [.99,.92,.53], [.52,.69,.99], [.99,.58,.56],
      [.77,.58,.92], [1,.76,.47], [.56,.86,.70], [.84,.48,.45],
    ];
    for(const ball of state.balls)if(!ball.pocketed){
      sphere(dynamic,ball.x,.16,ball.z,palette[ball.id]??[1,1,1],ball.id>=9);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,gpu.dynamicBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(dynamic),gl.DYNAMIC_DRAW);
    if(dynamic.length)render(gpu.dynamicBuffer,dynamic.length/6);
    lastDraw=now;
  }
  function tick(now:number) {
    raf=0;
    if(disposed||lost||!canvas.isConnected||document.hidden)return;
    const elapsed=lastTime?Math.min(.067,Math.max(0,(now-lastTime)/1000)):0;
    lastTime=now;carry+=elapsed;
    let steps=0,changed=false;
    while(carry>=POOL_DT&&steps<8) {
      const next=stepPool(state);
      changed ||=next!==state;state=next;carry-=POOL_DT;steps++;
    }
    if(steps===8)carry=0;
    if(changed)onState(outwardState(state));
    if(!lastDraw||now-lastDraw>=1000/30)draw(now);
    raf=requestAnimationFrame(tick);
  }
  function resume(){
    if(!disposed&&!lost&&gpu&&!document.hidden&&!raf){
      lastTime=0;carry=0;raf=requestAnimationFrame(tick);
    }
  }
  function visibility(){
    if(document.hidden){
      if(raf)cancelAnimationFrame(raf);raf=0;lastTime=0;carry=0;
    }else resume();
  }
  function lostContext(event:Event){
    event.preventDefault();lost=true;
    if(raf)cancelAnimationFrame(raf);raf=0;gpu=null;
    onLost?.();
  }
  function restoreContext() {
    if(disposed)return;
    try{gpu=allocate(gl,api,staticData);lost=false;lastDraw=0;resume();onRestored?.();}
    catch{lost=true;gpu=null;onLost?.();}
  }
  canvas.addEventListener('webglcontextlost',lostContext);
  canvas.addEventListener('webglcontextrestored',restoreContext);
  document.addEventListener('visibilitychange',visibility);
  resume();
  return {
    get state(){return outwardState(state);},
    get isGraphicsAvailable(){return !disposed&&!lost&&gpu!==null;},
    shoot(angle,power){
      if(disposed||lost||!gpu)return false;
      const next=strikePool(state,angle,power);
      if(next===state)return false;
      state=next;onState(outwardState(state));return true;
    },
    placeLocalTable(next){
      if(disposed||lost||!gpu)return false;
      const accepted=acceptLocalPoolPlacement(state,next);
      if(!accepted)return false;
      state=accepted;carry=0;lastTime=0;lastDraw=0;onState(outwardState(state));
      return true;
    },
    reset(){if(disposed)return;state=newPoolPractice();carry=0;onState(outwardState(state));},
    dispose(){
      if(disposed)return;disposed=true;
      if(raf)cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost',lostContext);
      canvas.removeEventListener('webglcontextrestored',restoreContext);
      document.removeEventListener('visibilitychange',visibility);
      if(gpu&&!lost)free(gl,gpu);
      gpu=null;
    },
  };
}

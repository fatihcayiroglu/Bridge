import { GOLF_HOLE, GOLF_LIMITS, GOLF_FIXED_DT, newGolfRound, stepGolf, strikeGolf, type GolfState } from './mini-golf-physics.ts';
import { selectSocialWebGLContext, socialRoomShaderSources, socialRoomRenderSize } from './social-room-render-policy.ts';

/**
 * Genuine 3D WebGL1/2 practice course. Local and solo only.
 * No textures, external assets, microphone, tracking, room join or scores API.
 */
export interface MiniGolfHandle {
  get state(): GolfState;
  shoot(degrees: number, power: number): boolean;
  reset(): void;
  dispose(): void;
  readonly isGraphicsAvailable: boolean;
}
type Gl = WebGLRenderingContext;
type Color = readonly [number, number, number];

function box(out: number[], x: number, y: number, z: number, w: number, h: number, d: number, color: Color): void {
  const points = [
    [x-w/2,y,z-d/2], [x+w/2,y,z-d/2], [x+w/2,y+h,z-d/2], [x-w/2,y+h,z-d/2],
    [x-w/2,y,z+d/2], [x+w/2,y,z+d/2], [x+w/2,y+h,z+d/2], [x-w/2,y+h,z+d/2],
  ];
  for (const [a,b,c,d0,light] of [
    [4,5,6,7,1], [1,0,3,2,.69], [0,4,7,3,.77],
    [5,1,2,6,.85], [3,7,6,2,1.1], [0,1,5,4,.6],
  ]) {
    for(const i of [a,b,c,a,c,d0]) {
      const p=points[i]!;
      out.push(p[0]!,p[1]!,p[2]!,...color.map(v=>Math.min(1,v*light)));
    }
  }
}
function disc(out: number[], x: number, y: number, z: number, radius: number, color: Color): void {
  for(let i=0;i<24;i++){
    const a=2*Math.PI*i/24,b=2*Math.PI*(i+1)/24;
    for(const p of [[x,y,z],[x+radius*Math.cos(a),y,z+radius*Math.sin(a)],
      [x+radius*Math.cos(b),y,z+radius*Math.sin(b)]]) out.push(...p,...color);
  }
}
function ball(out: number[], x: number, y: number, z: number): void {
  const radius=.14;
  for(let i=0;i<8;i++)for(let j=0;j<12;j++){
    const theta0=Math.PI*i/8,theta1=Math.PI*(i+1)/8;
    const phi0=2*Math.PI*j/12,phi1=2*Math.PI*(j+1)/12;
    const p=(t:number,a:number)=>[
      x+radius*Math.sin(t)*Math.cos(a),
      y+radius*Math.cos(t),
      z+radius*Math.sin(t)*Math.sin(a),
    ];
    const a=p(theta0,phi0),b=p(theta1,phi0),c=p(theta1,phi1),d=p(theta0,phi1);
    const shade=Math.min(1,.72+.28*Math.cos(phi0));
    for (const v of [a,b,c,a,c,d]) out.push(...v,shade,shade,Math.min(1,shade*.94));
  }
}
function course(): Float32Array {
  const v:number[]=[];
  const grass:Color=[.12,.46,.35], boundary:Color=[.63,.43,.25];
  box(v,0,-.24,0,5.25,.22,10.0,[.08,.25,.25]);
  box(v,0,-.06,0,4.5,.075,9.2,grass);
  for(const x of [-2.40,2.40])box(v,x,-.03,0,.2,.42,9.5,boundary);
  for(const z of [-4.70,4.70])box(v,0,-.03,z,5.0,.42,.2,boundary);
  disc(v,GOLF_HOLE.x,.035,GOLF_HOLE.z,.33,[.018,.031,.038]);
  disc(v,GOLF_HOLE.x,.036,GOLF_HOLE.z,.20,[.006,.012,.019]);
  box(v,.35,.04,GOLF_HOLE.z,.05,1.65,.05,[.91,.91,.86]);
  box(v,.58,1.28,GOLF_HOLE.z,.48,.28,.04,[.94,.31,.35]);
  for(const x of [-3.5,3.5])box(v,x,-.14,0,.40,.12,10,[.18,.40,.50]);
  return new Float32Array(v);
}
function projection(aspect:number):Float32Array{
  const f=1/Math.tan(Math.PI/5),near=.1,far=60;
  return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0]);
}
function view():Float32Array{
  const e=[0,8.4,11.2],a=[0,0,-.8];
  const norm=(v:number[])=>{const n=Math.hypot(...v)||1;return v.map(i=>i/n);};
  const z=norm(e.map((v,i)=>v-a[i]!)),x=norm([z[2]!,0,-z[0]!]);
  const y=[z[1]!*x[2]!-z[2]!*x[1]!,z[2]!*x[0]!-z[0]!*x[2]!,z[0]!*x[1]!-z[1]!*x[0]!];
  return new Float32Array([
    x[0]!,y[0]!,z[0]!,0,x[1]!,y[1]!,z[1]!,0,x[2]!,y[2]!,z[2]!,0,
    -x.reduce((n,v,i)=>n+v*e[i]!,0),-y.reduce((n,v,i)=>n+v*e[i]!,0),
    -z.reduce((n,v,i)=>n+v*e[i]!,0),1,
  ]);
}
interface Resources {
  vertex:WebGLShader; fragment:WebGLShader; program:WebGLProgram;
  staticBuffer:WebGLBuffer; movingBuffer:WebGLBuffer;
  position:number; color:number; proj:WebGLUniformLocation; view:WebGLUniformLocation;
}
function allocate(gl:Gl,api:'webgl1'|'webgl2',data:Float32Array):Resources{
  let vertex:WebGLShader|null=null,fragment:WebGLShader|null=null,program:WebGLProgram|null=null;
  let staticBuffer:WebGLBuffer|null=null,movingBuffer:WebGLBuffer|null=null;
  try{
    const shaders=socialRoomShaderSources(api);
    const compile=(kind:number,source:string)=>{
      const shader=gl.createShader(kind);
      if(!shader)throw Error('WebGL shader allocation failed');
      gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);throw Error('WebGL shader failed');}
      return shader;
    };
    vertex=compile(gl.VERTEX_SHADER,shaders.vertex);
    fragment=compile(gl.FRAGMENT_SHADER,shaders.fragment);
    program=gl.createProgram();
    if(!program)throw Error('WebGL program unavailable');
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('WebGL program link failed');
    staticBuffer=gl.createBuffer();movingBuffer=gl.createBuffer();
    if(!staticBuffer||!movingBuffer)throw Error('WebGL buffers unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER,staticBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'aPosition'),color=gl.getAttribLocation(program,'aColor');
    const proj=gl.getUniformLocation(program,'uProjection'),viewLoc=gl.getUniformLocation(program,'uView');
    if(position<0||color<0||!proj||!viewLoc)throw Error('WebGL attributes unavailable');
    gl.enable(gl.DEPTH_TEST);
    return {vertex,fragment,program,staticBuffer,movingBuffer,position,color,proj,view:viewLoc};
  }catch(e){
    if(movingBuffer)gl.deleteBuffer(movingBuffer);
    if(staticBuffer)gl.deleteBuffer(staticBuffer);
    if(program)gl.deleteProgram(program);
    if(vertex)gl.deleteShader(vertex);
    if(fragment)gl.deleteShader(fragment);
    throw e;
  }
}
function release(gl:Gl,gpu:Resources){
  gl.deleteBuffer(gpu.staticBuffer);gl.deleteBuffer(gpu.movingBuffer);
  gl.deleteProgram(gpu.program);gl.deleteShader(gpu.vertex);gl.deleteShader(gpu.fragment);
}
export function startMiniGolfPractice(canvas:HTMLCanvasElement,onState:(state:GolfState)=>void):MiniGolfHandle|null {
  const context=selectSocialWebGLContext(canvas);
  if(!context)return null;
  const {gl,api}=context;
  const staticData=course();
  let gpu:Resources|null=allocate(gl,api,staticData);
  let state=newGolfRound(),disposed=false,lost=false,raf=0,lastTime=0,acc=0,lastDraw=0;
  const camera=view();
  onState(state);
  function draw(now:number){
    if(!gpu)return;
    const rect=canvas.getBoundingClientRect();
    const size=socialRoomRenderSize(rect.width,rect.height,window.devicePixelRatio||1,'balanced');
    if(canvas.width!==size.width||canvas.height!==size.height){canvas.width=size.width;canvas.height=size.height;}
    gl.viewport(0,0,size.width,size.height);
    gl.clearColor(.045,.105,.14,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(gpu.program);
    gl.uniformMatrix4fv(gpu.proj,false,projection(size.width/size.height));
    gl.uniformMatrix4fv(gpu.view,false,camera);
    const render=(buffer:WebGLBuffer,vertices:number)=>{
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(gpu!.position);gl.enableVertexAttribArray(gpu!.color);
      gl.vertexAttribPointer(gpu!.position,3,gl.FLOAT,false,24,0);
      gl.vertexAttribPointer(gpu!.color,3,gl.FLOAT,false,24,12);
      gl.drawArrays(gl.TRIANGLES,0,vertices);
    };
    render(gpu.staticBuffer,staticData.length/6);
    const moving:number[]=[];
    ball(moving,state.x,.23,state.z);
    gl.bindBuffer(gl.ARRAY_BUFFER,gpu.movingBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(moving),gl.DYNAMIC_DRAW);
    render(gpu.movingBuffer,moving.length/6);
    lastDraw=now;
  }
  function frame(now:number){
    raf=0;
    if(disposed||lost||!canvas.isConnected||document.hidden)return;
    const elapsed=lastTime?Math.min(.067,Math.max(0,(now-lastTime)/1000)):0;
    lastTime=now;
    acc+=elapsed;
    let steps=0,changed=false;
    while(acc>=GOLF_FIXED_DT&&steps<8){
      const next=stepGolf(state);
      changed ||= next!==state;
      state=next;
      acc-=GOLF_FIXED_DT;steps++;
    }
    if(steps===8)acc=0;
    if(changed)onState(state);
    if(!lastDraw||now-lastDraw>=1000/30)draw(now);
    raf=requestAnimationFrame(frame);
  }
  function resume(){
    if(!disposed&&!lost&&gpu&&!document.hidden&&!raf){lastTime=0;acc=0;raf=requestAnimationFrame(frame);}
  }
  function visibility(){
    if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;lastTime=0;acc=0;}
    else resume();
  }
  function contextLost(event:Event){
    event.preventDefault();lost=true;
    if(raf)cancelAnimationFrame(raf);raf=0;gpu=null;
    onState(state);
  }
  function contextRestored(){
    if(disposed)return;
    try{gpu=allocate(gl,api,staticData);lost=false;lastDraw=0;resume();}
    catch{gpu=null;lost=true;onState(state);}
  }
  canvas.addEventListener('webglcontextlost',contextLost);
  canvas.addEventListener('webglcontextrestored',contextRestored);
  document.addEventListener('visibilitychange',visibility);
  resume();
  return {
    get state(){return state;},
    get isGraphicsAvailable(){return !disposed&&!lost&&gpu!==null;},
    shoot(degrees,power){
      if(disposed||lost||!gpu)return false;
      const next=strikeGolf(state,degrees,power);
      if(next===state)return false;
      state=next;onState(state);return true;
    },
    reset(){if(disposed)return;state=newGolfRound();acc=0;onState(state);},
    dispose(){
      if(disposed)return;disposed=true;
      if(raf)cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost',contextLost);
      canvas.removeEventListener('webglcontextrestored',contextRestored);
      document.removeEventListener('visibilitychange',visibility);
      if(gpu&&!lost)release(gl,gpu);
      gpu=null;
    },
  };
}

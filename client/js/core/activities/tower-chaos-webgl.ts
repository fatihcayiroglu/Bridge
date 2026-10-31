import {
  isTowerMatch,newTowerChaos,removeTowerChaosBlock,towerLegalBlockIds,
  type TowerMatch,type TowerPlayer,
} from './tower-chaos-physics.ts';
import {towerChaosGeometry} from './tower-chaos-geometry.ts';
import {TOWER_CAMERA_EYE,TOWER_TAN_HALF_FOV,towerCameraBasis} from './tower-chaos-picking.ts';
import {
  selectSocialWebGLContext,socialRoomShaderSources,socialRoomRenderSize,
} from './social-room-render-policy.ts';

/**
 * Genuine WebGL1/2, offline only. The renderer never determines outcomes,
 * and a context loss permanently invalidates this session (even if restored).
 */
export interface TowerChaosHandle {
  readonly match:TowerMatch;
  readonly graphicsAvailable:boolean;
  readonly graphicsApi:'webgl1'|'webgl2';
  remove(player:TowerPlayer,blockId:number):boolean;
  /** Display-only target; cannot remove a block or change actor. */
  setSelectedBlock(blockId:number|null):boolean;
  dispose():void;
}
type Gl=WebGLRenderingContext|WebGL2RenderingContext;
interface Gpu {
  readonly vertex:WebGLShader;readonly fragment:WebGLShader;
  readonly program:WebGLProgram;readonly buffer:WebGLBuffer;
  readonly position:number;readonly color:number;
  readonly proj:WebGLUniformLocation;readonly view:WebGLUniformLocation;
}
function allocate(gl:Gl,api:'webgl1'|'webgl2'):Gpu {
  const sources=socialRoomShaderSources(api);
  let vertex:WebGLShader|null=null,fragment:WebGLShader|null=null,
    program:WebGLProgram|null=null,buffer:WebGLBuffer|null=null;
  try {
    const shader=(kind:number,source:string):WebGLShader=>{
      const s=gl.createShader(kind);if(!s)throw Error('TOWER_SHADER_ALLOC');
      gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
        gl.deleteShader(s);throw Error('TOWER_SHADER_COMPILE');
      }
      return s;
    };
    vertex=shader(gl.VERTEX_SHADER,sources.vertex);
    fragment=shader(gl.FRAGMENT_SHADER,sources.fragment);
    program=gl.createProgram();
    if(!program)throw Error('TOWER_PROGRAM_ALLOC');
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('TOWER_PROGRAM_LINK');
    buffer=gl.createBuffer();
    if(!buffer)throw Error('TOWER_BUFFER_ALLOC');
    const position=gl.getAttribLocation(program,'aPosition');
    const color=gl.getAttribLocation(program,'aColor');
    const proj=gl.getUniformLocation(program,'uProjection');
    const view=gl.getUniformLocation(program,'uView');
    if(position<0||color<0||!proj||!view)throw Error('TOWER_UNIFORMS');
    gl.enable(gl.DEPTH_TEST);
    return {vertex,fragment,program,buffer,position,color,proj,view};
  }catch(e){
    if(buffer)gl.deleteBuffer(buffer);
    if(program)gl.deleteProgram(program);
    if(vertex)gl.deleteShader(vertex);
    if(fragment)gl.deleteShader(fragment);
    throw e;
  }
}
function release(gl:Gl,gpu:Gpu):void {
  gl.deleteBuffer(gpu.buffer);gl.deleteProgram(gpu.program);
  gl.deleteShader(gpu.vertex);gl.deleteShader(gpu.fragment);
}
function projection(aspect:number):Float32Array {
  const f=1/TOWER_TAN_HALF_FOV,near=.1,far=45;
  return new Float32Array([
    f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,
    0,0,2*far*near/(near-far),0,
  ]);
}
function view():Float32Array {
  const {right:x,up:y,back:z}=towerCameraBasis();
  const eye=TOWER_CAMERA_EYE;
  return new Float32Array([
    x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,
    -x.reduce((a,n,i)=>a+n*eye[i]!,0),
    -y.reduce((a,n,i)=>a+n*eye[i]!,0),
    -z.reduce((a,n,i)=>a+n*eye[i]!,0),1,
  ]);
}

const copyMatch=(m:TowerMatch):TowerMatch=>({
  ...m,blocks:m.blocks.map(b=>({...b})),
  last:m.last?{...m.last}:null,
});

export function startTowerChaosWebGL(canvas:HTMLCanvasElement,
  onState:(match:TowerMatch)=>void,onGraphicsLost:()=>void,
):TowerChaosHandle|null {
  if(!canvas.isConnected)return null;
  const selected=selectSocialWebGLContext(canvas);
  if(!selected)return null;
  const {gl,api}=selected;
  let gpu:Gpu;
  try{gpu=allocate(gl,api);}catch{return null;}
  let match=newTowerChaos(),disposed=false,lost=false,detached=false,
    raf=0,lastDraw=0,dirty=true,selectedId:number|null=null;
  const camera=view();
  function connected():boolean {
    if(!canvas.isConnected)detached=true;
    return !detached;
  }
  const available=()=>!disposed&&!lost&&!gl.isContextLost()&&connected();
  function draw(now:number):void {
    if(!available())return;
    const rect=canvas.getBoundingClientRect();
    const size=socialRoomRenderSize(rect.width,rect.height,
      window.devicePixelRatio||1,'balanced');
    if(canvas.width!==size.width||canvas.height!==size.height){
      canvas.width=size.width;canvas.height=size.height;dirty=true;
    }
    if(!dirty&&now-lastDraw<1000/30)return;
    const vertices=towerChaosGeometry(match,0,selectedId);
    if(!vertices){invalidate();return;}
    gl.viewport(0,0,size.width,size.height);
    gl.clearColor(.065,.095,.15,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(gpu.program);
    gl.uniformMatrix4fv(gpu.proj,false,projection(size.width/size.height));
    gl.uniformMatrix4fv(gpu.view,false,camera);
    gl.bindBuffer(gl.ARRAY_BUFFER,gpu.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(gpu.position);
    gl.enableVertexAttribArray(gpu.color);
    gl.vertexAttribPointer(gpu.position,3,gl.FLOAT,false,24,0);
    gl.vertexAttribPointer(gpu.color,3,gl.FLOAT,false,24,12);
    gl.drawArrays(gl.TRIANGLES,0,vertices.length/6);
    dirty=false;lastDraw=now;
  }
  function frame(now:number):void {
    raf=0;
    if(!available()||document.hidden)return;
    draw(now);
    if(available())raf=requestAnimationFrame(frame);
  }
  function start():void {
    if(available()&&!document.hidden&&!raf)
      raf=requestAnimationFrame(frame);
  }
  function invalidate():void {
    if(lost||disposed)return;
    lost=true;if(raf)cancelAnimationFrame(raf);raf=0;
    onGraphicsLost();
  }
  function onLost(e:Event):void {e.preventDefault();invalidate();}
  function onRestored():void {
    // No silent reactivation: a previously lost game needs a fresh canvas.
    invalidate();
  }
  function visibility():void {
    if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;}
    else {dirty=true;start();}
  }
  canvas.addEventListener('webglcontextlost',onLost);
  canvas.addEventListener('webglcontextrestored',onRestored);
  document.addEventListener('visibilitychange',visibility);
  onState(copyMatch(match));
  start();
  return {
    get match(){return copyMatch(match);},
    get graphicsAvailable(){return available();},
    get graphicsApi(){return api;},
    remove(player,blockId){
      if(!available()||!isTowerMatch(match))return false;
      const next=removeTowerChaosBlock(match,player,blockId);
      if(!next)return false;
      match=next;selectedId=null;dirty=true;onState(copyMatch(match));start();
      return true;
    },
    setSelectedBlock(blockId){
      if(!available()||match.phase!=='playing'||
          (blockId!==null&&(!Number.isSafeInteger(blockId)||
            !towerLegalBlockIds(match).includes(blockId))))return false;
      if(selectedId!==blockId){selectedId=blockId;dirty=true;start();}
      return true;
    },
    dispose(){
      if(disposed)return;
      disposed=true;if(raf)cancelAnimationFrame(raf);raf=0;
      canvas.removeEventListener('webglcontextlost',onLost);
      canvas.removeEventListener('webglcontextrestored',onRestored);
      document.removeEventListener('visibilitychange',visibility);
      if(!lost&&!gl.isContextLost())release(gl,gpu);
    },
  };
}

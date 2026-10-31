import {activityStringsForLanguage} from './bridge-activities-copy.ts';
import {
  startTowerChaosWebGL,type TowerChaosHandle,
} from './tower-chaos-webgl.ts';
import {
  towerLegalBlockIds,type TowerMatch,
} from './tower-chaos-physics.ts';
import {towerHitTest} from './tower-chaos-hit-test.ts';

export interface TowerChaosPanelHandle {dispose():void}
/**
 * Experimental local two-person Tower Chaos panel. No network or persistent
 * score, no unverified graphics play, no silent resume after WebGL context loss.
 * Block selection is shared by an accessible native select and a guarded
 * physical pointer gesture; picking alone can never remove a block.
 */
export function showTowerChaosPanel(container:HTMLElement,onBack:()=>void):
  TowerChaosPanelHandle {
  const s=activityStringsForLanguage(document.documentElement.lang);
  container.replaceChildren();
  let disposed=false,blocked=false,generation=0;
  let live:TowerChaosHandle|null=null;
  const node=<K extends keyof HTMLElementTagNameMap>(
    tag:K,cls='',label?:string,
  ):HTMLElementTagNameMap[K]=>{
    const el=document.createElement(tag);el.className=cls;
    if(label!==undefined)el.textContent=label;return el;
  };
  const button=(label:string,cls:string,click:()=>void)=>{
    const b=node('button',cls,label);b.type='button';
    b.addEventListener('click',click);return b;
  };
  const back=button(s.backToGames,'bridge-room-direction bridge-tower-back',()=>{
    if(disposed)return;
    disposed=true;generation++;retireCanvasPicking(canvas);
    live?.dispose();live=null;onBack();
  });
  const heading=node('h3','bridge-mini-golf-heading',s.towerTitle);
  const help=node('p','bridge-activities-help',s.towerHelp);
  let canvas=node('canvas','bridge-activities-canvas bridge-tower-canvas');
  canvas.setAttribute('aria-label',s.towerTitle);
  const status=node('p','bridge-room-status bridge-tower-status');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const notice=node('p','bridge-room-status bridge-tower-notice');
  notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const controls=node('div','bridge-mini-golf-controls');
  const choose=node('label','bridge-mini-golf-label',s.towerChoose);
  const selected=node('select','bridge-tower-block');
  selected.setAttribute('aria-label',s.towerChoose);
  choose.append(selected);
  selected.addEventListener('change',()=>{
    if(disposed||blocked||!live?.graphicsAvailable||selected.disabled||
        selected.value==='')return;
    const id=Number(selected.value);
    if(!towerLegalBlockIds(live.match).includes(id)||!live.select(id))return;
    notice.textContent=s.towerPicked+' '+(id+1);
  });
  // A press/release gesture only CHOOSES a visible block. Never act on
  // an orphan pointerup, a different pointer, a drag, or a retired canvas.
  type Press={pointerId:number;x:number;y:number;generation:number};
  let pressed:Press|null=null;
  const clearPress=()=>{pressed=null;};
  const eligible=(event:PointerEvent):boolean=>
    event.isPrimary===true&&event.button===0&&
    Number.isSafeInteger(event.pointerId)&&event.pointerId>=0&&
    Number.isFinite(event.clientX)&&Number.isFinite(event.clientY);
  const pressStart=(event:PointerEvent)=>{
    pressed=null;
    if(disposed||blocked||!live?.graphicsAvailable||
        event.currentTarget!==canvas||selected.disabled||!eligible(event))return;
    const rect=canvas.getBoundingClientRect();
    if(!Number.isFinite(rect.width)||!Number.isFinite(rect.height)||
        rect.width<=0||rect.height<=0||
        event.clientX<rect.left||event.clientY<rect.top||
        event.clientX>rect.left+rect.width||
        event.clientY>rect.top+rect.height)return;
    pressed={pointerId:event.pointerId,x:event.clientX,y:event.clientY,generation};
  };
  const chooseVisibleBlock=(event:PointerEvent)=>{
    const start=pressed;pressed=null;
    if(!start||disposed||blocked||!live?.graphicsAvailable||
        event.currentTarget!==canvas||selected.disabled||!eligible(event)||
        start.generation!==generation||start.pointerId!==event.pointerId||
        Math.hypot(event.clientX-start.x,event.clientY-start.y)>12)return;
    const bounds=canvas.getBoundingClientRect();
    const id=towerHitTest(live.match,event.clientX-bounds.left,
      event.clientY-bounds.top,bounds.width,bounds.height);
    if(id===null||![...selected.options].some(o=>o.value===String(id)))return;
    selected.value=String(id);
    selected.dispatchEvent(new Event('change',{bubbles:true}));
  };
  const bindCanvasPicking=(target:HTMLCanvasElement)=>{
    target.addEventListener('pointerdown',pressStart);
    target.addEventListener('pointerup',chooseVisibleBlock);
    target.addEventListener('pointercancel',clearPress);
    target.addEventListener('pointerleave',clearPress);
  };
  const retireCanvasPicking=(target:HTMLCanvasElement)=>{
    pressed=null;
    target.removeEventListener('pointerdown',pressStart);
    target.removeEventListener('pointerup',chooseVisibleBlock);
    target.removeEventListener('pointercancel',clearPress);
    target.removeEventListener('pointerleave',clearPress);
  };
  const remove=button(s.towerRemove,'bridge-room-direction bridge-tower-remove',()=>{
    if(disposed||blocked||!live||!live.graphicsAvailable||
        !live.remove(live.match.currentPlayer,Number(selected.value))){
      notice.textContent=s.towerInvalid;return;
    }
    notice.textContent='';
    render(live.match);
  });
  controls.append(choose,remove);
  const restart=button(s.towerRestart,'bridge-room-direction bridge-tower-restart',()=>{
    if(disposed||restart.hidden)return;
    begin();
    if(restart.hidden)selected.focus();
    else restart.focus();
  });
  const setRestart=(visible:boolean)=>{
    restart.hidden=!visible;
    restart.style.display=visible?'':'none';
  };
  setRestart(false);
  container.append(back,heading,help,canvas,status,notice,controls,restart);

  function render(match:TowerMatch):void {
    if(disposed)return;
    const legal=blocked||!live?.graphicsAvailable?[]:towerLegalBlockIds(match);
    const old=selected.value;
    selected.replaceChildren(...legal.map(id=>{
      const option=node('option','',s.towerBlock+' '+(id+1)+
        ' · '+s.towerLayer+' '+(Math.floor(id/3)+1));
      option.value=String(id);return option;
    }));
    if(old!==''&&legal.includes(Number(old)))selected.value=old;
    else selected.selectedIndex=legal.length?0:-1;
    const finished=match.phase==='collapsed';
    const available=!blocked&&!!live?.graphicsAvailable;
    selected.disabled=!available||finished;
    remove.disabled=!available||finished||legal.length===0;
    // The visual highlight follows both pointer and native keyboard input.
    // The shader tint is never an authority for choosing the move outcome.
    if(available&&selected.value!==''&&!finished)
      live?.select(Number(selected.value));
    else if(available)live?.select(null);
    setRestart(finished||!available);
    status.textContent=!available?s.towerGraphicsLost:
      finished?s.towerWinner+' '+((match.winner??0)+1)+' · '+
        s.towerMoves+': '+match.moves:
        s.towerPlayer+' '+(match.currentPlayer+1)+' · '+
        s.towerMoves+': '+match.moves;
  }
  function begin():void {
    if(disposed)return;
    const retired=live;live=null;retired?.dispose();
    generation++;
    blocked=false;notice.textContent='';status.textContent='';
    selected.replaceChildren();selected.disabled=true;remove.disabled=true;
    const fresh=node('canvas','bridge-activities-canvas bridge-tower-canvas');
    fresh.setAttribute('aria-label',s.towerTitle);
    retireCanvasPicking(canvas);
    canvas.replaceWith(fresh);canvas=fresh;
    bindCanvasPicking(canvas);
    const mine=generation;
    try{
      const next=startTowerChaosWebGL(canvas,snapshot=>{
        if(!disposed&&mine===generation&&live)render(snapshot);
      },()=>{
        if(disposed||mine!==generation)return;
        blocked=true;
        if(live)render(live.match);
      });
      if(!next)throw Error('TOWER_WEBGL_UNAVAILABLE');
      live=next;render(next.match);
    }catch{
      blocked=true;live=null;
      setRestart(true);status.textContent=s.towerGraphicsLost;
      notice.textContent=s.noWebgl;
    }
  }
  begin();
  return {dispose(){if(disposed)return;disposed=true;generation++;
    retireCanvasPicking(canvas);
    live?.dispose();live=null;}};
}

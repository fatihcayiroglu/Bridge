import {activityStringsForLanguage} from './bridge-activities-copy.ts';
import {
  startTowerChaosWebGL,type TowerChaosHandle,
} from './tower-chaos-webgl.ts';
import {
  towerLegalBlockIds,type TowerMatch,
} from './tower-chaos-physics.ts';
import {towerPickBlock} from './tower-chaos-picking.ts';

export interface TowerChaosPanelHandle {dispose():void}
/**
 * Experimental local two-person Tower Chaos panel. No network or persistent
 * score, no unverified graphics play, no silent resume after WebGL context loss.
 * Block selection is an accessible native select (not a fake canvas hit).
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
    disposed=true;generation++;live?.dispose();live=null;onBack();
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
  // Canvas taps only CHOOSE an available block. A separate confirmation button
  // executes the turn; drags, secondary clicks and stale GPU sessions cannot.
  function bindCanvasPicking(target:HTMLCanvasElement,owner:number):void {
    let start:{id:number;x:number;y:number}|null=null;
    target.addEventListener('pointerdown',event=>{
      start=null;
      if(disposed||blocked||owner!==generation||!live?.graphicsAvailable||
          event.button!==0||!event.isPrimary)return;
      start={id:event.pointerId,x:event.clientX,y:event.clientY};
    });
    target.addEventListener('pointercancel',()=>{start=null;});
    target.addEventListener('pointerup',event=>{
      const pressed=start;start=null;
      if(!pressed||event.pointerId!==pressed.id||!event.isPrimary||
          event.button!==0||Math.hypot(event.clientX-pressed.x,
            event.clientY-pressed.y)>12||disposed||blocked||
          owner!==generation||!live?.graphicsAvailable||
          live.match.phase!=='playing')return;
      const bounds=target.getBoundingClientRect();
      if(!bounds.width||!bounds.height)return;
      const x=(event.clientX-bounds.left)/bounds.width;
      const y=(event.clientY-bounds.top)/bounds.height;
      if(x<0||x>1||y<0||y>1)return;
      const blockId=towerPickBlock(live.match,2*x-1,1-2*y,
        bounds.width/bounds.height);
      if(blockId===null||!towerLegalBlockIds(live.match).includes(blockId)){
        notice.textContent=s.towerNoBlock;
        return;
      }
      selected.value=String(blockId);
      if(selected.value!==String(blockId))return;
      notice.textContent=s.towerSelected+' '+(blockId+1);
    });
  }
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
    if(legal.includes(Number(old)))selected.value=old;
    const finished=match.phase==='collapsed';
    const available=!blocked&&!!live?.graphicsAvailable;
    selected.disabled=!available||finished;
    remove.disabled=!available||finished||legal.length===0;
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
    canvas.replaceWith(fresh);canvas=fresh;
    const mine=generation;
    bindCanvasPicking(canvas,mine);
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
    live?.dispose();live=null;}};
}

import { BridgeRegistry } from '../bridge-registry.ts';
import { activityStringsForLanguage } from './bridge-activities-copy.ts';
import { closeExclusivePeers } from '../exclusive-surface.ts';
import { BRIDGE_3D_GAME_CATALOG, BRIDGE_SOCIAL_SPACE } from './bridge-game-catalog.ts';
import { startLocalSocialRoom, type RoomDirection, type SocialRoomHandle } from './social-room-webgl.ts';
import { joinSocialRoomPreview, type SocialClient, type SocialClientStatus, type SocialSocket } from './social-room-client.ts';
import { startMiniGolfPractice, type MiniGolfHandle } from './mini-golf-webgl.ts';
import type { GolfState } from './mini-golf-physics.ts';
import { startPoolPractice, type PoolPracticeHandle } from './pool-practice-webgl.ts';
import { POOL_TARGET_COUNT, type PoolState } from './pool-practice-physics.ts';
import { declarePracticePocketCall, settlePracticePocketCall, type PracticePocketCall } from './pool-practice-call.ts';
import { joinOnlineMiniGolf, type OnlineGolfSession, type OnlineGolfMatch, type OnlineGolfStatus } from './mini-golf-client.ts';

type ActivitiesTab = 'games' | 'social';
let overlay: HTMLDivElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousAppInert = false;
let room: SocialRoomHandle | null = null;
let socialSession: SocialClient | null = null;
let miniGolf: MiniGolfHandle | null = null;
let poolPractice: PoolPracticeHandle | null = null;
let onlineGolf: OnlineGolfSession | null = null;
let currentTab: ActivitiesTab = 'games';

function strings() {
  return activityStringsForLanguage(document.documentElement.lang);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function makeButton(label: string, className: string, action: () => void): HTMLButtonElement {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function disposeRoom(): void {
  onlineGolf?.dispose();
  onlineGolf = null;
  miniGolf?.dispose();
  miniGolf = null;
  poolPractice?.dispose();
  poolPractice = null;
  socialSession?.dispose();
  socialSession = null;
  room?.dispose();
  room = null;
}

function hideBridgeActivities(restoreFocus = true): void {
  disposeRoom();
  if (!overlay) return;
  const last = overlay;
  overlay = null;
  document.removeEventListener('keydown', onDocumentKeydown);
  last.remove();
  const app = document.getElementById('app');
  if (app) app.inert = previousAppInert;
  if (restoreFocus && previousFocus?.isConnected && !document.hidden) previousFocus.focus();
  previousFocus = null;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!overlay) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hideBridgeActivities();
    return;
  }
  if (event.key !== 'Tab') return;
  // Include native interactive controls used by Mini Golf, Pool and social
  // graphics settings. Exclude negative-tabindex tabs and hidden descendants.
  // A modal must not leak keyboard focus into the underlying application.
  const targets = [...overlay.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
    'select:not([disabled]),textarea:not([disabled]),a[href],canvas[tabindex="0"],[tabindex="0"]',
  )].filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0 &&
    !item.closest('[hidden],[inert],[aria-hidden="true"]'));
  if (!targets.length) { event.preventDefault(); return; }
  if (!overlay.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? targets[targets.length - 1]! : targets[0]!).focus();
    return;
  }
  if (event.shiftKey && document.activeElement === targets[0]) {
    event.preventDefault();
    targets[targets.length - 1]!.focus();
  } else if (!event.shiftKey && document.activeElement === targets[targets.length - 1]) {
    event.preventDefault();
    targets[0]!.focus();
  }
}

function showMiniGolf(container: HTMLElement): void {
  // Solo practice by default; online authority is separately feature gated
  // and only started by an explicit action. Never use activity:start, claim
  // production-ready multiplayer or ask for microphone permissions.
  const s = strings();
  container.replaceChildren();
  const back = makeButton(s.backToGames, 'bridge-room-direction', () => {
    onlineGolf?.dispose();
    onlineGolf = null;
    miniGolf?.dispose();
    miniGolf = null;
    container.replaceChildren();
    showGames(container);
  });
  back.classList.add('bridge-mini-golf-back');
  const heading = element('h3', 'bridge-mini-golf-heading', 'Mini Golf · ' + s.solo);
  const help = element('p', 'bridge-activities-help', s.golfHelp);
  const canvas = element('canvas', 'bridge-activities-canvas bridge-mini-golf-canvas');
  canvas.setAttribute('aria-label', 'Mini Golf 3D');
  const status = element('p', 'bridge-room-status bridge-mini-golf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const controls = element('div', 'bridge-mini-golf-controls');
  const onlineHelp = element('p', 'bridge-activities-help', s.golfOnlineHelp);
  const onlineStatus = element('p', 'bridge-room-status bridge-mini-golf-online-status', s.roomStatus);
  onlineStatus.setAttribute('role','status');
  onlineStatus.setAttribute('aria-live','polite');
  const scoreboard = element('ol', 'bridge-mini-golf-scoreboard');
  const resultsHeading = element('h4', 'bridge-mini-golf-results-heading', s.golfRankings);
  const results = element('ul', 'bridge-mini-golf-results');
  resultsHeading.hidden = true;
  const startButton = makeButton(s.golfStart, 'bridge-room-direction bridge-mini-golf-start', () => {
    onlineGolf?.start();
  });
  startButton.hidden = true;
  const rematchButton = makeButton(s.golfRematch, 'bridge-room-direction bridge-mini-golf-rematch', () => {
    onlineGolf?.rematch();
  });
  rematchButton.hidden = true;
  const onlineButton = makeButton(s.golfJoin, 'bridge-room-direction bridge-mini-golf-online-button', toggleOnline);
  let joiningOnline = false;
  function updateMatch(match: OnlineGolfMatch): void {
    scoreboard.replaceChildren();
    results.replaceChildren();
    resultsHeading.hidden = match.phase !== 'finished';
    if (match.phase === 'finished') {
      for (const item of match.results) {
        const seat = match.players.findIndex(p => p.userId === item.userId) + 1;
        const description = s.golfRank + ' ' + item.rank + ' · ' +
          s.golfPlayer + ' ' + seat + (item.userId === match.you ? ' ' + s.golfYou : '') +
          ' · ' + s.golfStrokes + ': ' + item.strokes +
          ' · ' + (item.holed ? s.golfGoal : s.golfStrokeLimit);
        results.append(element('li', '', description));
      }
    }
    match.players.forEach((p, index) => {
      const label = s.golfPlayer + ' ' + (index + 1) +
        (p.userId === match.you ? ' ' + s.golfYou : '') +
        ' · ' + s.golfStrokes + ': ' + p.strokes + (p.won ? ' · ' + s.golfGoal : '') +
        (p.reconnecting ? ' · ' + s.golfReconnecting : '');
      scoreboard.append(element('li', '', label));
    });
    const displayed = match.players.find(p => p.userId === match.turnUserId) ??
      match.players.find(p => p.userId === match.you);
    if (!displayed || !miniGolf?.setAuthoritativeBall(displayed.x, displayed.z)) {
      onlineGolf?.dispose(); return;
    }
    const paused = match.players.some(p => p.reconnecting);
    const finished = match.phase === 'finished';
    const alreadyReady = match.rematchReady.includes(match.you);
    rematchButton.hidden = !finished;
    rematchButton.disabled = !finished || paused || alreadyReady;
    rematchButton.textContent = (alreadyReady ? s.golfRematchMarked : s.golfRematch) +
      ' · ' + s.golfRematchReady + ': ' +
      match.rematchReady.length + '/' + match.players.length;
    const canStart = !paused && match.phase === 'waiting' && match.players.length >= match.minPlayers &&
      match.players.length <= match.maxPlayers && match.players[0]?.userId === match.you;
    startButton.hidden = !canStart;
    startButton.disabled = !canStart;
    const myTurn = match.phase === 'playing' && match.turnUserId === match.you;
    const canShoot = myTurn && !paused && miniGolf.isGraphicsAvailable;
    shoot.disabled = !canShoot;
    aim.disabled = !canShoot;
    power.disabled = !canShoot;
    reset.disabled = true;
    onlineStatus.textContent = paused ? s.golfPaused : match.phase === 'waiting'
      ? s.golfLobby + ' · ' + match.players.length + '/' + match.maxPlayers + ' · ' +
        (match.players.length < match.minPlayers ? s.golfWait : s.golfWaitStart) :
      match.phase === 'finished' ? s.golfFinished : myTurn ? s.golfTurn : s.golfOtherTurn;
  }
  function onlineState(status: OnlineGolfStatus): void {
    if (status === 'connecting') {
      heading.textContent = 'Mini Golf · ' + (joiningOnline || onlineGolf?.active ? s.golfOnlineMode : s.solo);
      onlineStatus.textContent = s.golfConnecting;
      shoot.disabled = true;
      aim.disabled = true;
      power.disabled = true;
      reset.disabled = true;
      startButton.disabled = true;
      rematchButton.disabled = true;
      return;
    }
    if (status === 'waiting' || status === 'playing' || status === 'finished') {
      heading.textContent = 'Mini Golf · ' + s.golfOnlineMode;
      onlineButton.textContent = s.golfLeave;
      joiningOnline = false;
      return;
    }
    joiningOnline = false;
    onlineGolf = null;
    miniGolf?.leaveOnline();
    scoreboard.replaceChildren();
    results.replaceChildren();
    resultsHeading.hidden = true;
    startButton.hidden = true;
    rematchButton.hidden = true;
    heading.textContent = 'Mini Golf · ' + s.solo;
    onlineButton.textContent = s.golfJoin;
    onlineStatus.textContent = {
      unavailable: s.golfUnavailable, invalid: s.golfInvalid,
      disconnected: s.golfDisconnected,
    }[status];
    shoot.disabled = false;
    aim.disabled = false;
    power.disabled = false;
    reset.disabled = false;
  }
  function toggleOnline(): void {
    if (onlineGolf || joiningOnline) {
      onlineGolf?.dispose();
      onlineGolf = null;
      joiningOnline = false;
      return;
    }
    const selected = BridgeRegistry.call<unknown>('getCurrentServer');
    const rawId = selected && typeof selected === 'object' ? (selected as { _id?: unknown })._id : null;
    const serverId = typeof rawId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rawId) ? rawId : null;
    const socketValue = BridgeRegistry.get<unknown>('socket');
    const socket = socketValue && typeof socketValue === 'object'
      ? socketValue as SocialSocket : null;
    if (!serverId || !socket?.connected || !miniGolf?.isGraphicsAvailable) {
      onlineStatus.textContent = serverId ? s.golfUnavailable : s.chooseServer;
      return;
    }
    miniGolf.reset();
    joiningOnline = true;
    onlineButton.textContent = s.golfLeave;
    onlineGolf = joinOnlineMiniGolf(socket, serverId, updateMatch, onlineState);
  }
  const aimLabel = element('label', 'bridge-mini-golf-label', s.golfAim);
  const aim = element('input', 'bridge-mini-golf-aim');
  aim.type = 'range'; aim.min = '-70'; aim.max = '70'; aim.step = '5'; aim.value = '0';
  aimLabel.append(aim);
  const powerLabel = element('label', 'bridge-mini-golf-label', s.golfPower);
  const power = element('input', 'bridge-mini-golf-power');
  power.type = 'range'; power.min = '10'; power.max = '100'; power.step = '5'; power.value = '60';
  powerLabel.append(power);
  const shoot = makeButton(s.golfShoot, 'bridge-room-direction bridge-mini-golf-shoot', () => {
    if (onlineGolf?.active) onlineGolf.shoot(Number(aim.value), Number(power.value));
    else if (!joiningOnline) miniGolf?.shoot(Number(aim.value), Number(power.value));
  });
  const reset = makeButton(s.golfReset, 'bridge-room-direction bridge-mini-golf-reset', () => {
    if (!onlineGolf && !joiningOnline) miniGolf?.reset();
  });
  function update(state: GolfState): void {
    if (onlineGolf || joiningOnline) return;
    status.textContent = s.golfStrokes + ': ' + state.strokes + ' · ' + (
      state.status === 'won' ? s.golfWon : state.status === 'moving' ? s.golfMoving : s.golfReady
    );
    const playable = state.status === 'ready' && (miniGolf?.isGraphicsAvailable ?? true);
    shoot.disabled = !playable;
    aim.disabled = !playable;
    power.disabled = !playable;
  }
  controls.append(aimLabel, powerLabel, shoot, reset);
  container.append(back, heading, help, canvas, status, controls,
    onlineHelp, onlineStatus, onlineButton, startButton, rematchButton,
    scoreboard, resultsHeading, results);
  try {
    miniGolf = startMiniGolfPractice(canvas, update, () => {
      onlineGolf?.dispose();
      onlineGolf = null;
      onlineStatus.textContent = s.graphicsLost;
    });
    if (!miniGolf) {
      status.textContent = s.noWebgl;
      shoot.disabled = true;
      onlineButton.disabled = true;
      return;
    }
    update(miniGolf.state);
  } catch {
    miniGolf?.dispose();
    miniGolf = null;
    status.textContent = s.noWebgl;
    shoot.disabled = true;
    onlineButton.disabled = true;
  }
}

/** A second genuinely playable local 3D practice, not networked 8-ball. */
function showPoolPractice(container:HTMLElement):void {
  const s=strings();
  container.replaceChildren();
  const back=makeButton(s.backToGames,'bridge-room-direction bridge-pool-back',()=>{
    poolPractice?.dispose();
    poolPractice=null;
    container.replaceChildren();showGames(container);
  });
  const heading=element('h3','bridge-mini-golf-heading','8-Ball Pool · '+s.poolSolo);
  const help=element('p','bridge-activities-help',s.poolHelp);
  const canvas=element('canvas','bridge-activities-canvas bridge-pool-canvas');
  canvas.setAttribute('aria-label','3D Pool pocket practice');
  const status=element('p','bridge-room-status bridge-pool-status');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const controls=element('div','bridge-mini-golf-controls');
  const callLabel=element('label','bridge-mini-golf-label',s.poolCallChallenge);
  const callEnabled=element('input','bridge-pool-call-enabled');
  callEnabled.type='checkbox';callLabel.append(callEnabled);
  const ballLabel=element('label','bridge-mini-golf-label',s.poolCallBall);
  const callBall=element('select','bridge-pool-call-ball');
  for(let id=1;id<=POOL_TARGET_COUNT;id++) {
    const option=element('option','',String(id));
    option.value=String(id);callBall.append(option);
  }
  ballLabel.append(callBall);
  const pocketLabel=element('label','bridge-mini-golf-label',s.poolCallPocket);
  const callPocket=element('select','bridge-pool-call-pocket');
  s.poolPocketNames.forEach((name,i)=>{
    const option=element('option','',name);option.value=String(i);
    callPocket.append(option);
  });
  pocketLabel.append(callPocket);
  const callResult=element('p','bridge-room-status bridge-pool-call-result',s.poolCallPrompt);
  callResult.setAttribute('role','status');callResult.setAttribute('aria-live','polite');
  let pending:PracticePocketCall|null=null;
  callEnabled.addEventListener('change',()=>{
    if(!callEnabled.checked)pending=null;
    callResult.textContent=s.poolCallPrompt;
    if(poolPractice)update(poolPractice.state);
  });
  const aimLabel=element('label','bridge-mini-golf-label',s.poolAim);
  const aim=element('input','bridge-pool-aim');
  aim.type='range';aim.min='-70';aim.max='70';aim.step='5';aim.value='0';
  aimLabel.append(aim);
  const powerLabel=element('label','bridge-mini-golf-label',s.poolPower);
  const power=element('input','bridge-pool-power');
  power.type='range';power.min='10';power.max='100';power.step='5';power.value='60';
  powerLabel.append(power);
  const shoot=makeButton(s.poolShoot,'bridge-room-direction bridge-pool-shoot',()=>{
    if(!poolPractice)return;
    const call=callEnabled.checked?declarePracticePocketCall(
      poolPractice.state,Number(callBall.value),Number(callPocket.value)):null;
    if(callEnabled.checked&&!call){
      callResult.textContent=s.poolCallInvalid;
      return;
    }
    if(poolPractice.shoot(Number(aim.value),Number(power.value))) {
      pending=call;
      if(pending)callResult.textContent=s.poolCallPending;
    }
  });
  const reset=makeButton(s.poolReset,'bridge-room-direction bridge-pool-reset',()=>{
    pending=null;callResult.textContent=s.poolCallPrompt;
    poolPractice?.reset();
  });
  function update(state:PoolState):void {
    status.textContent=s.poolShots+': '+state.shots+' · '+s.poolPocketed+': '+state.pocketed+
      '/'+POOL_TARGET_COUNT+' · '+s.poolScratches+': '+state.scratches+' · '+
      (state.status==='complete'?s.poolComplete:
        state.status==='moving'?s.poolMoving:s.poolReady);
    if(pending&&state.shots===pending.shot&&state.status!=='moving') {
      const outcome=settlePracticePocketCall(state,pending);
      callResult.textContent=outcome==='made'?s.poolCallMade:
        outcome==='missed'?s.poolCallMissed:s.poolCallUnverified;
      pending=null;
    }
    const ready=state.status==='ready' && (poolPractice?.isGraphicsAvailable??true);
    shoot.disabled=!ready;aim.disabled=!ready;power.disabled=!ready;
    callEnabled.disabled=!(poolPractice?.isGraphicsAvailable??true)||
      state.status==='moving';
    callBall.disabled=!ready||!callEnabled.checked;
    callPocket.disabled=!ready||!callEnabled.checked;
  }
  controls.append(callLabel,ballLabel,pocketLabel,aimLabel,powerLabel,shoot,reset);
  container.append(back,heading,help,canvas,status,callResult,controls);
  try{
    poolPractice=startPoolPractice(canvas,update,()=>{
      pending=null;callResult.textContent=s.poolCallUnverified;
      shoot.disabled=true;aim.disabled=true;power.disabled=true;
      callEnabled.disabled=true;callBall.disabled=true;callPocket.disabled=true;
      status.textContent=s.graphicsLost;
    },()=>{if(poolPractice)update(poolPractice.state);});
    if(!poolPractice){
      status.textContent=s.noWebgl;shoot.disabled=true;reset.disabled=true;
      aim.disabled=true;power.disabled=true;
      callEnabled.disabled=true;callBall.disabled=true;callPocket.disabled=true;return;
    }
    update(poolPractice.state);
  }catch{
    poolPractice?.dispose();poolPractice=null;
    status.textContent=s.noWebgl;
    shoot.disabled=true;reset.disabled=true;aim.disabled=true;power.disabled=true;
    callEnabled.disabled=true;callBall.disabled=true;callPocket.disabled=true;
  }
}

function showGames(container: HTMLElement): void {
  const s = strings();
  container.append(element('p', 'bridge-activities-help', s.gamesHelp));
  const grid = element('div', 'bridge-activities-grid');
  for (const game of BRIDGE_3D_GAME_CATALOG) {
    const card = element('article', 'bridge-activities-card');
    card.append(
      element('h3', '', game.title),
      element('p', '', String(game.minPlayers) + '–' + String(game.maxPlayers) + ' ' + s.players),
      element('span', game.state === 'solo-practice' ? 'bridge-activities-solo' : 'bridge-activities-planned',
        game.state === 'solo-practice' ? s.solo : s.planned),
    );
    if (game.state === 'solo-practice') {
      const isGolf=game.id==='mini-golf';
      const play=makeButton(isGolf?s.tryGolf:s.tryPool,
        'bridge-room-direction bridge-mini-golf-launch',
        ()=>isGolf?showMiniGolf(container):showPoolPractice(container));
      play.setAttribute('data-game-id',game.id);
      card.append(play);
    }
    grid.append(card);
  }
  container.append(grid);
}

function directionControl(
  label: string, direction: RoomDirection,
): HTMLButtonElement {
  const button = element('button', 'bridge-room-direction', label);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  const stop = () => room?.setDirection(direction, false);
  button.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    room?.setDirection(direction, true);
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
  button.addEventListener('blur', stop);
  return button;
}

function showSocial(container: HTMLElement): void {
  const s = strings();
  container.append(
    element('p', 'bridge-activities-help', s.socialHelp),
    element('p', 'bridge-room-status', s.roomStatus),
  );
  const canvas = element('canvas', 'bridge-activities-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', s.social + ': ' + s.moveHelp);
  container.append(canvas);
  const controls = element('div', 'bridge-room-controls');
  controls.append(
    directionControl('↑ ' + s.forward, 'forward'),
    directionControl('← ' + s.left, 'left'),
    directionControl('↓ ' + s.back, 'back'),
    directionControl('→ ' + s.right, 'right'),
  );
  container.append(controls, element('p', 'bridge-activities-help', s.moveHelp));
  try {
    const graphicsWarning = element('p', 'bridge-room-error');
    graphicsWarning.setAttribute('role', 'status');
    graphicsWarning.setAttribute('aria-live', 'polite');
    let onlineJoin: HTMLButtonElement | null = null;
    let allowJoinOnRestore = false;
    room = startLocalSocialRoom(
      canvas, direction => socialSession?.step(direction),
      () => {
        socialSession?.dispose();
        socialSession = null;
        room?.leaveOnline();
        if (onlineJoin) onlineJoin.disabled = true;
        graphicsWarning.textContent = s.graphicsLost;
        canvas.setAttribute('aria-disabled', 'true');
      },
      () => {
        canvas.removeAttribute('aria-disabled');
        graphicsWarning.textContent = s.graphicsRestored;
        if (onlineJoin) onlineJoin.disabled = !allowJoinOnRestore;
      },
    );
    if (!room) {
      container.append(element('p', 'bridge-room-error', s.noWebgl));
      return;
    }
    const graphicsMode = element('p', 'bridge-room-status',
      s.graphicsMode + ': ' + (room.graphicsApi === 'webgl2' ? 'WebGL 2' : 'WebGL 1'));
    const qualityLabel = element('label', 'bridge-room-quality-label', s.quality);
    qualityLabel.htmlFor = 'bridge-room-quality';
    const qualitySelect = element('select', 'bridge-room-quality');
    qualitySelect.id = 'bridge-room-quality';
    for (const [value, title] of [['low', s.low], ['balanced', s.balanced], ['high', s.high]]) {
      const option = element('option', '', title);
      option.value = value;
      if (value === 'balanced') option.selected = true;
      qualitySelect.append(option);
    }
    qualitySelect.addEventListener('change', () => {
      const selected = qualitySelect.value;
      if (selected === 'low' || selected === 'balanced' || selected === 'high') {
        room?.setQuality(selected);
      }
    });
    container.append(graphicsMode, qualityLabel, qualitySelect, graphicsWarning);
    // The network protocol is an explicit, optional experiment. Merely opening
    // this tab neither joins a server room nor reads mic/camera permissions.
    const chosen = BridgeRegistry.call<unknown>('getCurrentServer');
    const candidate = chosen && typeof chosen === 'object' ? (chosen as { _id?: unknown })._id : null;
    const serverId = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
    allowJoinOnRestore = Boolean(serverId);
    const currentSocket = BridgeRegistry.get<unknown>('socket');
    const socket = currentSocket && typeof currentSocket === 'object'
      ? currentSocket as SocialSocket : null;
    const onlineStatus = element('p', 'bridge-room-status', serverId ? s.roomStatus : s.chooseServer);
    onlineStatus.setAttribute('role', 'status');
    onlineStatus.setAttribute('aria-live', 'polite');
    const joinButton = makeButton(s.tryOnline, 'bridge-room-direction', () => {
      if (!serverId || !room || !room.isGraphicsAvailable) return;
      if (socialSession?.active) {
        socialSession.dispose();
        socialSession = null;
        room.leaveOnline();
        joinButton.textContent = s.tryOnline;
        return;
      }
      // Read the canonical socket at the moment of the click. Reconnect may
      // replace it since the modal first opened.
      const live = BridgeRegistry.get<unknown>('socket');
      const chosenSocket = live && typeof live === 'object' ? live as SocialSocket : socket;
      if (!chosenSocket || !chosenSocket.connected ||
          typeof chosenSocket.on !== 'function' || typeof chosenSocket.off !== 'function' ||
          typeof chosenSocket.emit !== 'function') {
        onlineStatus.textContent = s.onlineUnavailable;
        return;
      }
      socialSession = joinSocialRoomPreview(
        chosenSocket, serverId,
        (snapshot, ownSocketId) => room?.setOnlinePeers(snapshot.peers, ownSocketId) ?? false,
        (status: SocialClientStatus) => {
          if (status !== 'online') room?.leaveOnline();
          const message = {
            connecting: s.onlineConnecting, online: s.onlineOnline,
            unavailable: s.onlineUnavailable, disconnected: s.onlineDisconnected,
            invalid: s.onlineInvalid,
          }[status];
          onlineStatus.textContent = message;
          joinButton.textContent = status === 'online' ? s.leaveOnline : s.tryOnline;
        },
      );
    });
    onlineJoin = joinButton;
    joinButton.disabled = !serverId || !room.isGraphicsAvailable;
    container.append(onlineStatus, joinButton);
  } catch {
    disposeRoom();
    container.append(element('p', 'bridge-room-error', s.noWebgl));
  }
}

function switchTab(tab: ActivitiesTab): void {
  if (!overlay) return;
  currentTab = tab;
  disposeRoom();
  const body = overlay.querySelector<HTMLElement>('#bridge-activities-body');
  if (!body) return;
  body.replaceChildren();
  for (const button of overlay.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const active = button.dataset.tab === currentTab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  if (tab === 'social') showSocial(body);
  else showGames(body);
}

export function showBridgeActivities(tab: ActivitiesTab = 'games'): void {
  const app = document.getElementById('app');
  // This is an authenticated shell feature, never a public landing-page modal.
  if (!app || getComputedStyle(app).display === 'none') return;
  if (overlay) { switchTab(tab); return; }
  closeExclusivePeers('activities');
  const s = strings();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousAppInert = app.inert;
  const root = element('div', 'bridge-activities-overlay');
  root.setAttribute('role', 'presentation');
  const dialog = element('section', 'bridge-activities-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'bridge-activities-title');
  dialog.setAttribute('aria-describedby', 'bridge-activities-subtitle');
  const header = element('header', 'bridge-activities-header');
  const heading = element('div');
  const title = element('h2', '', s.title);
  title.id = 'bridge-activities-title';
  const subtitle = element('p', '', s.subtitle);
  subtitle.id = 'bridge-activities-subtitle';
  heading.append(title, subtitle);
  header.append(heading, makeButton('×', 'bridge-activities-close', () => hideBridgeActivities()));
  header.lastElementChild?.setAttribute('aria-label', s.close);
  const tabs = element('div', 'bridge-activities-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', s.title);
  const gamesTab = makeButton(s.games, 'bridge-activities-tab', () => switchTab('games'));
  gamesTab.setAttribute('role', 'tab');
  gamesTab.dataset.tab = 'games';
  gamesTab.setAttribute('aria-controls', 'bridge-activities-body');
  const socialTab = makeButton(s.social, 'bridge-activities-tab', () => switchTab('social'));
  socialTab.setAttribute('role', 'tab');
  socialTab.dataset.tab = 'social';
  socialTab.setAttribute('aria-controls', 'bridge-activities-body');
  tabs.append(gamesTab, socialTab);
  const body = element('div', 'bridge-activities-body');
  body.id = 'bridge-activities-body';
  body.setAttribute('role', 'tabpanel');
  dialog.append(header, tabs, body);
  root.append(dialog);
  root.addEventListener('pointerdown', event => {
    if (event.target === root) hideBridgeActivities();
  });
  overlay = root;
  document.body.append(root);
  app.inert = true;
  document.addEventListener('keydown', onDocumentKeydown);
  switchTab(tab);
  (tab === 'social' ? socialTab : gamesTab).focus();
}

// Register only when the feature is opened; no web renderer or GPU is loaded
// during the ordinary Bridge startup.
BridgeRegistry.register('showBridgeActivities', showBridgeActivities);
BridgeRegistry.register('closeBridgeActivities', hideBridgeActivities);
document.addEventListener('bridge:auth-logout', () => hideBridgeActivities(false));

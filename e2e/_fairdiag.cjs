const fs = require('fs'); const io = require('socket.io-client');
const BASE = 'http://127.0.0.1:3300';
const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json','utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json','utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hdr(t){const H={Authorization:'Bearer '+t,Accept:'application/json','User-Agent':'Mozilla/5.0 Chrome/120'};
  const c=(await (await fetch(BASE+'/api/csrf-token',{headers:H})).json()).token||'';
  return {...H,'Content-Type':'application/json','X-CSRF-Token':c};}
(async () => {
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'Diag '+Date.now()})})).json();
  const sid = srv._id||srv.id;
  const ch = await (await fetch(BASE+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'d'+Date.now(),type:'text'})})).json();
  const cid = ch._id||ch.id;
  const iv = await (await fetch(BASE+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  const users = POOL.users.slice(300, 303);
  for (const u of users) {
    const r = await fetch(BASE+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:await hdr(u.token),body:'{}'});
    console.log('  davet kullan:', r.status);
  }
  const socks = [];
  for (const u of users) {
    await new Promise(res => {
      const s = io(BASE,{auth:{token:u.token},transports:['websocket'],reconnection:false,timeout:15000});
      s.once('userAuthenticated', () => { s.emit('channel:join', cid); socks.push(s); res(); });
      s.on('connect_error', e => { console.log('  connect_error:', e.message); res(); });
    });
  }
  console.log('  bagli:', socks.length);
  let alinan = 0, hatalar = [];
  socks[0].on('message:new', m => { alinan++; });
  socks.forEach(s => s.on('error', e => hatalar.push(JSON.stringify(e).slice(0,90))));
  socks.forEach(s => s.on('error:ratelimit', e => hatalar.push('RL '+JSON.stringify(e).slice(0,60))));
  await sleep(800);
  socks[1].emit('message:send', { channelId: cid, serverId: sid, content: 'diag-test-1', ackId: 'd1' });
  socks[2].emit('message:send', { channelId: cid, serverId: sid, content: 'diag-test-2', ackId: 'd2' });
  await sleep(2500);
  console.log('  socks[0] aldi:', alinan);
  console.log('  hatalar:', hatalar.length ? hatalar.join(' | ') : 'yok');
  socks.forEach(s => s.close());
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });

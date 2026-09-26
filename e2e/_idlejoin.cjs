// Bir soket kanala katildiktan sonra BOSTA kalirsa yayin almayi surdurur mu?
const fs = require('fs'); const io = require('socket.io-client');
const BASE = 'http://127.0.0.1:3300';
const POOL = JSON.parse(fs.readFileSync(__dirname+'/fixtures/load-users.json','utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname+'/fixtures/tokens.json','utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hdr(t){const H={Authorization:'Bearer '+t,Accept:'application/json','User-Agent':'Mozilla/5.0 Chrome/120'};
  const c=(await (await fetch(BASE+'/api/csrf-token',{headers:H})).json()).token||'';
  return {...H,'Content-Type':'application/json','X-CSRF-Token':c};}
(async () => {
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'Idle '+Date.now()})})).json();
  const sid = srv._id||srv.id;
  const ch = await (await fetch(BASE+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'i'+Date.now(),type:'text'})})).json();
  const cid = ch._id||ch.id;
  const iv = await (await fetch(BASE+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  const users = POOL.users.slice(450, 452);
  for (const u of users) await fetch(BASE+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:await hdr(u.token),body:'{}'});

  const socks = [];
  for (const u of users) await new Promise(res => {
    const s = io(BASE,{auth:{token:u.token},transports:['websocket'],reconnection:false,timeout:15000});
    s.once('userAuthenticated', () => { s.emit('channel:join', cid); socks.push(s); res(); });
    s.on('connect_error', () => res());
  });
  let alinan = 0;
  socks[0].on('message:new', () => { alinan++; });
  await sleep(800);

  const gonder = (n) => socks[1].emit('message:send',{channelId:cid,serverId:sid,content:'idle-'+n,ackId:'i'+n});

  gonder(1); await sleep(1500);
  const t1 = alinan;
  console.log('  T+0s   gonderim sonrasi alinan:', t1);

  for (const bekle of [10, 20, 30]) {
    await sleep(bekle * 1000);
    const once = alinan;
    gonder('after' + bekle); await sleep(1800);
    console.log(`  ${bekle}s BOSTA sonrasi -> yeni alinan: ${alinan - once} (toplam ${alinan})`);
  }
  console.log('\n  bagli:', socks.map(s => s.connected).join(','));
  socks.forEach(s => s.close());
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });

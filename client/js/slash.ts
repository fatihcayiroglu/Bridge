// client/js/slash.js
// Slash command system: tÃ¼m komutlar + bot autocomplete + mod komutlarÄ±

(function () {

  // â”€â”€ BUILT-IN KOMUTLAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  interface SlashCommand {
    cmd:      string;
    desc:     string;
    usage:    string;
    category: string;
    modOnly?: boolean;
  }

  const BUILTIN_COMMANDS: SlashCommand[] = [
    // Genel
    { cmd: '/me',        desc: 'Eylem mesajÄ± gÃ¶nder',          usage: '/me dans eder',       category: 'genel' },
    { cmd: '/spoiler',   desc: 'Spoiler iÃ§erik yaz',           usage: '/spoiler iÃ§erik',     category: 'genel' },
    { cmd: '/shrug',     desc: 'Shrug gÃ¶nder',                 usage: '/shrug',              category: 'genel' },
    { cmd: '/tableflip', desc: 'Tableflip gÃ¶nder',             usage: '/tableflip',          category: 'genel' },
    { cmd: '/unflip',    desc: 'MasayÄ± yerine koy',            usage: '/unflip',             category: 'genel' },
    { cmd: '/lenny',     desc: 'Lenny yÃ¼zÃ¼ gÃ¶nder',            usage: '/lenny',              category: 'genel' },
    { cmd: '/giphy',     desc: 'Giphy GIF ara',                usage: '/giphy kedi',         category: 'medya' },
    { cmd: '/remind',    desc: 'HatÄ±rlatÄ±cÄ± kur',              usage: '/remind 5m toplantÄ±', category: 'araÃ§lar' },
    { cmd: '/clear',     desc: 'Mesaj kutusunu temizle',       usage: '/clear',              category: 'araÃ§lar' },
    { cmd: '/nick',      desc: 'GeÃ§ici gÃ¶rÃ¼nen ad deÄŸiÅŸtir',   usage: '/nick YeniAd',        category: 'araÃ§lar' },
    { cmd: '/help',      desc: 'Komut listesini gÃ¶ster',       usage: '/help',               category: 'araÃ§lar' },
    { cmd: '/tts',       desc: 'Metin sesli okunur',           usage: '/tts merhaba dÃ¼nya',  category: 'medya'   },
    { cmd: '/code',      desc: 'Kod bloÄŸu gÃ¶nder',             usage: '/code console.log()', category: 'genel'   },
    // Moderasyon (sunucu sahibi / moderatÃ¶r)
    { cmd: '/mute',      desc: 'KullanÄ±cÄ±yÄ± sustur',           usage: '/mute @kullanÄ±cÄ± 10m', category: 'mod', modOnly: true },
    { cmd: '/unmute',    desc: 'SusturmayÄ± kaldÄ±r',            usage: '/unmute @kullanÄ±cÄ±',   category: 'mod', modOnly: true },
    { cmd: '/kick',      desc: 'KullanÄ±cÄ±yÄ± at',               usage: '/kick @kullanÄ±cÄ±',     category: 'mod', modOnly: true },
    { cmd: '/ban',       desc: 'KullanÄ±cÄ±yÄ± banla',            usage: '/ban @kullanÄ±cÄ± sebep', category: 'mod', modOnly: true },
    { cmd: '/slow',      desc: 'YavaÅŸ mod aÃ§/kapat',           usage: '/slow 5',              category: 'mod', modOnly: true },
    { cmd: '/announce',  desc: 'Duyuru gÃ¶nder (embed)',        usage: '/announce Mesaj',      category: 'mod', modOnly: true },
    // Kanal
    { cmd: '/topic',     desc: 'Kanal konusunu deÄŸiÅŸtir',      usage: '/topic Yeni konu',     category: 'kanal', modOnly: true },
    { cmd: '/pin',       desc: 'MesajÄ± sabitle',               usage: '/pin <mesaj-id>',      category: 'kanal', modOnly: true },
  ];

  // Bot komutlarÄ± (sunucudan dinamik yÃ¼klenir)
  let _botCommands = [];
  // Aktif tÃ¼m komutlar (builtin + bot)
  let _allCommands = [...BUILTIN_COMMANDS];

  // â”€â”€ BOT KOMUTLARINI YÃœKLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Kanal/sunucu deÄŸiÅŸtiÄŸinde tetiklenir
  window.loadBotSlashCommands = async function (serverId) {
    if (!serverId) return;
    try {
      const r = await apiFetch(`${API}/api/bots/commands?serverId=${serverId}`);
      if (!r.ok) return;
      const data = await r.json();
      _botCommands = (data.commands || []).map(c => ({
        cmd:      c.command.startsWith('/') ? c.command : `/${c.command}`,
        desc:     c.description || 'Bot komutu',
        usage:    c.usage || c.command,
        category: 'bot',
        botName:  c.botName,
      }));
    } catch {
      _botCommands = [];
    }
    _allCommands = [...BUILTIN_COMMANDS, ..._botCommands];
  };

  let popupVisible  = false;
  let selectedIndex = 0;
  let filteredCmds  = [];

  // â”€â”€ AUTOCOMPLETE POPUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function showSlashPopup(commands) {
    filteredCmds  = commands;
    selectedIndex = 0;
    let popup = document.getElementById('slash-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id        = 'slash-popup';
      popup.className = 'slash-popup';
      document.body.appendChild(popup);
    }
    popup.innerHTML = '';

    // Kategoriye gÃ¶re grupla
    const byCategory = {};
    commands.forEach(c => {
      const cat = c.category || 'genel';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(c);
    });

    let globalIdx = 0;
    Object.entries(byCategory).forEach(([cat, cmds]) => {
      // Kategori baÅŸlÄ±ÄŸÄ±
      if (Object.keys(byCategory).length > 1) {
        const header = document.createElement('div');
        header.className = 'slash-category';
        const icons: Record<string, string> = { genel: '💬', medya: '🎬', 'araçlar': '🔧', mod: '🛡️', kanal: '📌', bot: '🤖' };
        header.textContent = `${icons[cat] || '•'} ${cat.toUpperCase()}`;
        popup.appendChild(header);
      }
      cmds.forEach(c => {
        const idx  = globalIdx++;
        const item = document.createElement('div');
        item.className = 'slash-item' + (idx === 0 ? ' selected' : '');
        item.innerHTML = `
          <span class="slash-cmd">${escHtml(c.cmd)}</span>
          <span class="slash-usage">${escHtml(c.usage)}</span>
          <span class="slash-desc">${escHtml(c.desc)}${c.botName ? ` <em class="slash-bot-tag">${escHtml(c.botName)}</em>` : ''}</span>
        `;
        item.addEventListener('mousedown', e => { e.preventDefault(); applySlashCommand(c.cmd); });
        popup.appendChild(item);
      });
    });

    positionPopup();
    popupVisible = true;
  }

  function hideSlashPopup() {
    document.getElementById('slash-popup')?.remove();
    popupVisible  = false;
    selectedIndex = 0;
    filteredCmds  = [];
  }

  function positionPopup() {
    const popup = document.getElementById('slash-popup');
    const input = document.getElementById('msg-input');
    if (!popup || !input) return;
    const rect = input.getBoundingClientRect();
    popup.style.bottom   = (window.innerHeight - rect.top + 6) + 'px';
    popup.style.left     = rect.left + 'px';
    popup.style.minWidth = rect.width + 'px';
    popup.style.maxHeight = '280px';
    popup.style.overflowY = 'auto';
  }

  function updatePopupSelection() {
    const items = popup => popup?.querySelectorAll('.slash-item') || [];
    const p = document.getElementById('slash-popup');
    const els = items(p);
    els.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    els[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function applySlashCommand(cmd) {
    const input = document.getElementById('msg-input');
    if (!input) return;
    input.value = cmd + ' ';
    input.focus();
    hideSlashPopup();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }

  // â”€â”€ HANDLE INPUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.handleSlashInput = function (value) {
    if (!value.startsWith('/')) { hideSlashPopup(); return false; }
    const query = value.toLowerCase();
    // BoÅŸluk varsa komut yazÄ±lmÄ±ÅŸ, popup'Ä± kapat
    if (value.indexOf(' ') !== -1) { hideSlashPopup(); return false; }

    const isMod = window.me?.role === 'admin' || window.currentMember?.permissions > 0;
    const pool  = _allCommands.filter(c => !c.modOnly || isMod);
    const matches = pool.filter(c =>
      c.cmd.startsWith(query) || query === '/'
    );
    if (matches.length) {
      showSlashPopup(matches);
      return true;
    }
    hideSlashPopup();
    return false;
  };

  // â”€â”€ HANDLE KEY IN POPUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.handleSlashKey = function (e) {
    if (!popupVisible) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filteredCmds.length;
      updatePopupSelection(); return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filteredCmds.length) % filteredCmds.length;
      updatePopupSelection(); return true;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (filteredCmds.length) {
        e.preventDefault();
        applySlashCommand(filteredCmds[selectedIndex].cmd);
        return true;
      }
    }
    if (e.key === 'Escape') { hideSlashPopup(); return true; }
    return false;
  };

  // â”€â”€ EXECUTE SLASH COMMAND â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.executeSlashCommand = function (content) {
    if (!content.startsWith('/')) return false;

    const parts  = content.trim().split(/\s+/);
    const cmd    = parts[0].toLowerCase();
    const args   = parts.slice(1).join(' ');
    const chanId = window.currentChannel?._id;
    const srvId  = window.currentServer?._id;

    function send(text) {
      socket.emit('message:send', { channelId: chanId, serverId: srvId, content: text });
    }

    switch (cmd) {
      case '/me':
        if (!args) return toast('/me iÃ§in eylem yazÄ±n', 'error'), true;
        send(`_${args}_`);
        return true;

      case '/spoiler':
        if (!args) return toast('/spoiler iÃ§in iÃ§erik yazÄ±n', 'error'), true;
        send(`||${args}||`);
        return true;

      case '/shrug':    send('Â¯\\_(ãƒ„)_/Â¯' + (args ? ' ' + args : '')); return true;
      case '/tableflip': send('(â•¯Â°â–¡Â°ï¼‰â•¯ï¸µ â”»â”â”»' + (args ? ' ' + args : '')); return true;
      case '/unflip':   send('â”¬â”€â”¬ ãƒ( ã‚œ-ã‚œãƒ)' + (args ? ' ' + args : '')); return true;
      case '/lenny':    send('( Í¡Â° ÍœÊ– Í¡Â°)' + (args ? ' ' + args : '')); return true;

      case '/tts':
        if (!args) return toast('/tts iÃ§in metin yazÄ±n', 'error'), true;
        if ('speechSynthesis' in window) {
          const utt = new SpeechSynthesisUtterance(args);
          utt.lang = document.documentElement.lang || 'tr-TR';
          speechSynthesis.speak(utt);
        }
        send(`ğŸ”Š _${args}_`);
        return true;

      case '/code':
        if (!args) return toast('/code iÃ§in kod yazÄ±n', 'error'), true;
        send('```\n' + args + '\n```');
        return true;

      case '/giphy':
        if (!args) return toast('/giphy iÃ§in arama terimi yazÄ±n', 'error'), true;
        fetchGiphy(args, chanId, srvId);
        return true;

      case '/remind':
        parseReminder(args, chanId, srvId);
        return true;

      case '/clear': {
        const input = document.getElementById('msg-input');
        if (input) { input.value = ''; input.style.height = 'auto'; }
        return true;
      }

      case '/nick': {
        if (!args) return toast('/nick iÃ§in yeni isim yazÄ±n', 'error'), true;
        apiFetch(`${API}/api/me`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: args.slice(0, 32) }),
        }).then(r => r.json()).then(u => {
          if (u.displayName) { window.me = { ...window.me, displayName: u.displayName }; toast(`GÃ¶rÃ¼nen adÄ±n deÄŸiÅŸti: ${u.displayName}`, 'success'); }
        }).catch(() => toast('Ad deÄŸiÅŸtirilemedi', 'error'));
        return true;
      }

      case '/help': {
        const isMod = window.me?.role === 'admin' || window.currentMember?.permissions > 0;
        const visible = _allCommands.filter(c => !c.modOnly || isMod);
        const lines = visible.map(c => `**${c.cmd}** â€” ${c.desc} \`${c.usage}\``).join('\n');
        toast('Komutlar konsolda listelendi', 'info');
        console.info('Bridge Slash KomutlarÄ±:\n' + visible.map(c => `  ${c.cmd.padEnd(14)} ${c.desc}`).join('\n'));
        send(`ğŸ“‹ **Mevcut komutlar:**\n${lines}`);
        return true;
      }

      // â”€â”€ MOD KOMUTLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case '/mute': {
        const [target, ...rest] = args.split(' ');
        const duration = rest[0] || '10m';
        if (!target) return toast('/mute @kullanÄ±cÄ± [sÃ¼re]', 'error'), true;
        const username = target.replace('@', '');
        apiFetch(`${API}/api/servers/${srvId}/members/${username}/mute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration }),
        }).then(r => r.ok ? toast(`ğŸ”‡ ${username} susturuldu`, 'success') : r.json().then(e => toast(e.error, 'error')))
          .catch(() => toast('Susturma baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/unmute': {
        const username = args.replace('@', '').trim();
        if (!username) return toast('/unmute @kullanÄ±cÄ±', 'error'), true;
        apiFetch(`${API}/api/servers/${srvId}/members/${username}/unmute`, { method: 'DELETE' })
          .then(r => r.ok ? toast(`ğŸ”‰ ${username} susturmasÄ± kaldÄ±rÄ±ldÄ±`, 'success') : toast('Hata', 'error'))
          .catch(() => toast('Ä°ÅŸlem baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/kick': {
        const username = args.replace('@', '').trim();
        if (!username) return toast('/kick @kullanÄ±cÄ±', 'error'), true;
        if (!confirm(`${username} kullanÄ±cÄ±sÄ±nÄ± sunucudan atmak istiyor musun?`)) return true;
        apiFetch(`${API}/api/servers/${srvId}/members/${username}/kick`, { method: 'DELETE' })
          .then(r => r.ok ? toast(`ğŸ‘¢ ${username} atÄ±ldÄ±`, 'success') : toast('Hata', 'error'))
          .catch(() => toast('Ä°ÅŸlem baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/ban': {
        const [target, ...reasonParts] = args.split(' ');
        const reason = reasonParts.join(' ') || 'Belirtilmedi';
        const username = target?.replace('@', '');
        if (!username) return toast('/ban @kullanÄ±cÄ± [sebep]', 'error'), true;
        if (!confirm(`${username} kullanÄ±cÄ±sÄ±nÄ± banlamak istiyor musun?\nSebep: ${reason}`)) return true;
        apiFetch(`${API}/api/servers/${srvId}/bans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, reason }),
        }).then(r => r.ok ? toast(`ğŸ”¨ ${username} banlandÄ±`, 'success') : r.json().then(e => toast(e.error, 'error')))
          .catch(() => toast('Ban iÅŸlemi baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/slow': {
        const seconds = parseInt(args) || 0;
        apiFetch(`${API}/api/channels/${chanId}/slowmode`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slowmode: seconds }),
        }).then(r => r.ok
          ? toast(seconds ? `ğŸ¢ YavaÅŸ mod: ${seconds}sn` : 'âš¡ YavaÅŸ mod kapatÄ±ldÄ±', 'success')
          : toast('Hata', 'error'))
          .catch(() => toast('Ä°ÅŸlem baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/announce': {
        if (!args) return toast('/announce Mesaj', 'error'), true;
        send(`ğŸ“¢ **Duyuru:** ${args}`);
        return true;
      }

      case '/topic': {
        if (!args) return toast('/topic Yeni konu', 'error'), true;
        apiFetch(`${API}/api/channels/${chanId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: args.slice(0, 1024) }),
        }).then(r => r.ok ? toast('ğŸ“Œ Kanal konusu gÃ¼ncellendi', 'success') : toast('Hata', 'error'));
        return true;
      }

      default:
        // Bot komutu olabilir â€” sunucuya ilet
        if (_botCommands.find(c => c.cmd === cmd)) {
          send(content); // bot dinliyor olacak
          return true;
        }
        return false;
    }
  };

  // â”€â”€ /GIPHY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function fetchGiphy(query, chanId, srvId) {
    try {
      const r   = await apiFetch(`${API}/api/media/giphy?q=${encodeURIComponent(query)}&limit=8`);
      if (!r.ok) return toast('Giphy eriÅŸilemiyor', 'error');
      const data = await r.json();
      const gifs = data.data || [];
      if (!gifs.length) return toast('GIF bulunamadÄ±', 'error');
      const picker = document.createElement('div');
      picker.className = 'giphy-picker';
      picker.id        = 'giphy-picker';
      gifs.forEach(g => {
        const url = g.images?.fixed_height_small?.url || g.images?.preview_gif?.url;
        if (!url) return;
        const img = document.createElement('img');
        img.src       = url;
        img.className = 'giphy-thumb';
        img.addEventListener('click', () => {
          socket.emit('message:send', { channelId: chanId, serverId: srvId, content: url });
          picker.remove();
        });
        picker.appendChild(img);
      });
      const input = document.getElementById('msg-input');
      const rect  = input?.getBoundingClientRect();
      if (rect) {
        picker.style.position = 'fixed';
        picker.style.bottom   = (window.innerHeight - rect.top + 8) + 'px';
        picker.style.left     = rect.left + 'px';
      }
      document.getElementById('giphy-picker')?.remove();
      document.body.appendChild(picker);
      setTimeout(() => {
        document.addEventListener('click', function h(e) {
          if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', h); }
        });
      }, 50);
    } catch { toast('Giphy baÄŸlantÄ± hatasÄ±', 'error'); }
  }

  // â”€â”€ /REMIND â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function parseReminder(args, chanId, srvId) {
    const match = args.match(/^(\d+)(s|m|h|d)\s+(.+)$/i);
    if (!match) return toast('KullanÄ±m: /remind 5m hatÄ±rlatÄ±cÄ± mesajÄ±', 'error');
    const amount = parseInt(match[1]);
    const unit   = match[2].toLowerCase();
    const text   = match[3];
    const ms = unit === 's' ? amount * 1000
             : unit === 'm' ? amount * 60000
             : unit === 'h' ? amount * 3600000
             : amount * 86400000;
    if (ms > 7 * 24 * 3600000) return toast('Maks hatÄ±rlatma sÃ¼resi 7 gÃ¼ndÃ¼r', 'error');
    if (ms < 5000) return toast('En az 5 saniye sÃ¼re girin', 'error');
    const label = unit === 's' ? `${amount} saniye` : unit === 'm' ? `${amount} dakika` : unit === 'h' ? `${amount} saat` : `${amount} gÃ¼n`;
    toast(`â° HatÄ±rlatÄ±cÄ± kuruldu: ${label} sonra`, 'success');
    setTimeout(() => {
      socket.emit('message:send', { channelId: chanId, serverId: srvId, content: `â° **HatÄ±rlatÄ±cÄ±:** ${text}` });
    }, ms);
  }

})();

(function () {

  const COMMANDS = [
    { cmd: '/me',        desc: 'Eylem mesajÄ± gÃ¶nder',         usage: '/me dans eder' },
    { cmd: '/spoiler',   desc: 'Spoiler iÃ§erik yaz',          usage: '/spoiler iÃ§erik' },
    { cmd: '/shrug',     desc: 'Shrug gÃ¶nder',                usage: '/shrug' },
    { cmd: '/tableflip', desc: 'Tableflip gÃ¶nder',            usage: '/tableflip' },
    { cmd: '/unflip',    desc: 'MasayÄ± yerine koy',           usage: '/unflip' },
    { cmd: '/lenny',     desc: 'Lenny yÃ¼zÃ¼ gÃ¶nder',           usage: '/lenny' },
    { cmd: '/giphy',     desc: 'Giphy GIF ara',               usage: '/giphy kedi' },
    { cmd: '/remind',    desc: 'HatÄ±rlatÄ±cÄ± kur',             usage: '/remind 5m toplantÄ±' },
    { cmd: '/clear',     desc: 'Mesaj kutusunu temizle',      usage: '/clear' },
    { cmd: '/nick',      desc: 'GeÃ§ici gÃ¶rÃ¼nen ad deÄŸiÅŸtir',  usage: '/nick YeniAd' },
  ];

  let popupVisible  = false;
  let selectedIndex = 0;
  let filteredCmds  = [];

  // â”€â”€ AUTOCOMPLETE POPUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function showSlashPopup(commands) {
    filteredCmds  = commands;
    selectedIndex = 0;
    let popup = document.getElementById('slash-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id        = 'slash-popup';
      popup.className = 'slash-popup';
      document.body.appendChild(popup);
    }
    popup.innerHTML = '';
    commands.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'slash-item' + (i === 0 ? ' selected' : '');
      item.innerHTML = `<span class="slash-cmd">${escHtml(c.cmd)}</span><span class="slash-desc">${escHtml(c.desc)}</span>`;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); applySlashCommand(c.cmd); });
      popup.appendChild(item);
    });
    positionPopup();
    popupVisible = true;
  }

  function hideSlashPopup() {
    document.getElementById('slash-popup')?.remove();
    popupVisible  = false;
    selectedIndex = 0;
    filteredCmds  = [];
  }

  function positionPopup() {
    const popup = document.getElementById('slash-popup');
    const input = document.getElementById('msg-input');
    if (!popup || !input) return;
    const rect = input.getBoundingClientRect();
    popup.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    popup.style.left   = rect.left + 'px';
    popup.style.minWidth = rect.width + 'px';
  }

  function updatePopupSelection() {
    const items = document.querySelectorAll('.slash-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function applySlashCommand(cmd) {
    const input = document.getElementById('msg-input');
    if (!input) return;
    input.value = cmd + ' ';
    input.focus();
    hideSlashPopup();
    // Place cursor at end
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }

  // â”€â”€ HANDLE INPUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.handleSlashInput = function (value) {
    if (!value.startsWith('/')) { hideSlashPopup(); return false; }
    const query = value.toLowerCase();
    const matches = COMMANDS.filter(c => c.cmd.startsWith(query) || query === '/');
    if (matches.length && value.indexOf(' ') === -1) {
      showSlashPopup(matches);
      return true;
    }
    hideSlashPopup();
    return false;
  };

  // â”€â”€ HANDLE KEY IN POPUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.handleSlashKey = function (e) {
    if (!popupVisible) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filteredCmds.length;
      updatePopupSelection(); return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filteredCmds.length) % filteredCmds.length;
      updatePopupSelection(); return true;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (filteredCmds.length) {
        e.preventDefault();
        applySlashCommand(filteredCmds[selectedIndex].cmd);
        return true;
      }
    }
    if (e.key === 'Escape') { hideSlashPopup(); return true; }
    return false;
  };

  // â”€â”€ EXECUTE SLASH COMMAND â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.executeSlashCommand = function (content) {
    if (!content.startsWith('/')) return false;

    const parts   = content.trim().split(/\s+/);
    const cmd     = parts[0].toLowerCase();
    const args    = parts.slice(1).join(' ');
    const chanId  = window.currentChannel?._id;
    const srvId   = window.currentServer?._id;

    function send(text) {
      socket.emit('message:send', { channelId: chanId, serverId: srvId, content: text });
    }

    switch (cmd) {
      case '/me':
        if (!args) return toast('/me iÃ§in eylem yazÄ±n', 'error'), true;
        send(`_${args}_`);
        return true;

      case '/spoiler':
        if (!args) return toast('/spoiler iÃ§in iÃ§erik yazÄ±n', 'error'), true;
        send(`||${args}||`);
        return true;

      case '/shrug':
        send('Â¯\\_(ãƒ„)_/Â¯' + (args ? ' ' + args : ''));
        return true;

      case '/tableflip':
        send('(â•¯Â°â–¡Â°ï¼‰â•¯ï¸µ â”»â”â”»' + (args ? ' ' + args : ''));
        return true;

      case '/unflip':
        send('â”¬â”€â”¬ ãƒ( ã‚œ-ã‚œãƒ)' + (args ? ' ' + args : ''));
        return true;

      case '/lenny':
        send('( Í¡Â° ÍœÊ– Í¡Â°)' + (args ? ' ' + args : ''));
        return true;

      case '/giphy':
        if (!args) return toast('/giphy iÃ§in arama terimi yazÄ±n', 'error'), true;
        fetchGiphy(args, chanId, srvId);
        return true;

      case '/remind':
        parseReminder(args, chanId, srvId);
        return true;

      case '/clear': {
        const input = document.getElementById('msg-input');
        if (input) { input.value = ''; input.style.height = 'auto'; }
        return true;
      }

      case '/nick': {
        if (!args) return toast('/nick iÃ§in yeni isim yazÄ±n', 'error'), true;
        apiFetch(`${API}/api/me`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: args.slice(0, 32) }),
        }).then(r => r.json()).then(u => {
          if (u.displayName) { window.me = { ...window.me, displayName: u.displayName }; toast(`GÃ¶rÃ¼nen adÄ±n deÄŸiÅŸti: ${u.displayName}`, 'success'); }
        }).catch(() => toast('Ad deÄŸiÅŸtirilemedi', 'error'));
        return true;
      }

      case '/mute': {
        const [muteTarget, ...muteDurParts] = args.split(/\s+/);
        const muteUsername = muteTarget?.replace(/^@/, '');
        if (!muteUsername) return toast('/mute @kullanÄ±cÄ± [dakika]', 'error'), true;
        const muteDur = parseInt(muteDurParts[0]) || 10;
        apiFetch(`${API}/api/servers/${srvId}/members/${muteUsername}/mute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ durationMinutes: muteDur }),
        }).then(r => r.ok ? toast(`ğŸ”‡ ${muteUsername} ${muteDur} dakika susturuldu`, 'success') : r.json().then(e => toast(e.error || 'Susturma baÅŸarÄ±sÄ±z', 'error')))
          .catch(() => toast('Susturma baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/unmute': {
        const unmuteUsername = args.trim().replace(/^@/, '');
        if (!unmuteUsername) return toast('/unmute @kullanÄ±cÄ±', 'error'), true;
        apiFetch(`${API}/api/servers/${srvId}/members/${unmuteUsername}/unmute`, { method: 'POST' })
          .then(r => r.ok ? toast(`ğŸ”Š ${unmuteUsername} susturmasÄ± kaldÄ±rÄ±ldÄ±`, 'success') : toast('Hata', 'error'))
          .catch(() => toast('Susturma kaldÄ±rÄ±lamadÄ±', 'error'));
        return true;
      }

      case '/kick': {
        const [kickTarget, ...kickReasonParts] = args.split(/\s+/);
        const kickUsername = kickTarget?.replace(/^@/, '');
        if (!kickUsername) return toast('/kick @kullanÄ±cÄ± [sebep]', 'error'), true;
        apiFetch(`${API}/api/servers/${srvId}/members/${kickUsername}/kick`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: kickReasonParts.join(' ') || 'Moderasyon' }),
        }).then(r => r.ok ? toast(`ğŸ‘¢ ${kickUsername} sunucudan atÄ±ldÄ±`, 'success') : r.json().then(e => toast(e.error || 'Atma baÅŸarÄ±sÄ±z', 'error')))
          .catch(() => toast('Atma baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/ban': {
        const [banTarget, ...banReasonParts] = args.split(/\s+/);
        const banUsername = banTarget?.replace(/^@/, '');
        if (!banUsername) return toast('/ban @kullanÄ±cÄ± [sebep]', 'error'), true;
        apiFetch(`${API}/api/servers/${srvId}/bans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: banUsername, reason: banReasonParts.join(' ') || 'Moderasyon' }),
        }).then(r => r.ok ? toast(`ğŸ”¨ ${banUsername} banlandÄ±`, 'success') : r.json().then(e => toast(e.error || 'Ban baÅŸarÄ±sÄ±z', 'error')))
          .catch(() => toast('Ban baÅŸarÄ±sÄ±z', 'error'));
        return true;
      }

      case '/slow': {
        const slowSec = parseInt(args) || 0;
        apiFetch(`${API}/api/channels/${chanId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slowMode: slowSec }),
        }).then(r => r.ok
          ? toast(slowSec > 0 ? `ğŸ¢ YavaÅŸ mod: ${slowSec}s` : 'âš¡ YavaÅŸ mod kapatÄ±ldÄ±', 'success')
          : toast('YavaÅŸ mod ayarlanamadÄ±', 'error'))
          .catch(() => toast('Hata', 'error'));
        return true;
      }

      case '/announce': {
        if (!args) return toast('/announce mesaj', 'error'), true;
        send(`ğŸ“¢ **Duyuru:** ${args}`);
        return true;
      }

      case '/topic': {
        if (!args) return toast('/topic Yeni konu', 'error'), true;
        apiFetch(`${API}/api/channels/${chanId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: args.slice(0, 1024) }),
        }).then(r => r.ok ? toast('ğŸ“Œ Kanal konusu gÃ¼ncellendi', 'success') : toast('Hata', 'error'));
        return true;
      }

      case '/help': {
        const helpLines = [
          '**KullanÄ±labilir Komutlar:**',
          '`/me <eylem>` â€” Eylem mesajÄ±',
          '`/spoiler <metin>` â€” Spoiler',
          '`/nick <isim>` â€” GÃ¶rÃ¼nen adÄ± deÄŸiÅŸtir',
          '`/giphy <arama>` â€” GIF gÃ¶nder',
          '`/remind <sÃ¼re> <hatÄ±rlatma>` â€” HatÄ±rlatÄ±cÄ± kur',
          '`/clear` â€” Mesaj kutusunu temizle',
          '`/mute @kullanÄ±cÄ± [dakika]` â€” Sustur (mod)',
          '`/unmute @kullanÄ±cÄ±` â€” SusturmayÄ± kaldÄ±r (mod)',
          '`/kick @kullanÄ±cÄ± [sebep]` â€” At (mod)',
          '`/ban @kullanÄ±cÄ± [sebep]` â€” Banla (mod)',
          '`/slow [saniye]` â€” YavaÅŸ mod (mod)',
          '`/topic <konu>` â€” Kanal konusu (mod)',
          '`/announce <mesaj>` â€” Duyuru (mod)',
        ];
        send(helpLines.join('\n'));
        return true;
      }

      default:
        // Bot komutu olabilir â€” sunucuya ilet
        if (_botCommands && _botCommands.find(c => c.cmd === cmd)) {
          socket.emit('bot:slash', {
            channelId: chanId,
            serverId:  srvId,
            command:   cmd,
            args,
            content,
          });
          return true;
        }
        return false;
    }
  };

  // â”€â”€ /GIPHY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function fetchGiphy(query, chanId, srvId) {
    try {
      const r   = await apiFetch(`${API}/api/media/giphy?q=${encodeURIComponent(query)}&limit=8`);
      if (!r.ok) return toast('Giphy eriÅŸilemiyor', 'error');
      const data = await r.json();
      const gifs = data.data || [];
      if (!gifs.length) return toast('GIF bulunamadÄ±', 'error');

      // Show a quick picker
      const picker = document.createElement('div');
      picker.className = 'giphy-picker';
      picker.id        = 'giphy-picker';
      gifs.forEach(g => {
        const url = g.images?.fixed_height_small?.url || g.images?.preview_gif?.url;
        if (!url) return;
        const img = document.createElement('img');
        img.src       = url;
        img.className = 'giphy-thumb';
        img.addEventListener('click', () => {
          socket.emit('message:send', { channelId: chanId, serverId: srvId, content: url });
          picker.remove();
        });
        picker.appendChild(img);
      });
      const input = document.getElementById('msg-input');
      const rect  = input?.getBoundingClientRect();
      if (rect) {
        picker.style.position = 'fixed';
        picker.style.bottom   = (window.innerHeight - rect.top + 8) + 'px';
        picker.style.left     = rect.left + 'px';
      }
      document.getElementById('giphy-picker')?.remove();
      document.body.appendChild(picker);
      setTimeout(() => {
        document.addEventListener('click', function h(e) {
          if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', h); }
        });
      }, 50);
    } catch { toast('Giphy baÄŸlantÄ± hatasÄ±', 'error'); }
  }

  // â”€â”€ /REMIND â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function parseReminder(args, chanId, srvId) {
    // Syntax: /remind <duration> <message>   e.g. /remind 5m toplantÄ±
    const match = args.match(/^(\d+)(s|m|h|d)\s+(.+)$/i);
    if (!match) return toast('KullanÄ±m: /remind 5m hatÄ±rlatÄ±cÄ± mesajÄ±', 'error');

    const amount = parseInt(match[1]);
    const unit   = match[2].toLowerCase();
    const text   = match[3];

    const ms = unit === 's' ? amount * 1000
             : unit === 'm' ? amount * 60000
             : unit === 'h' ? amount * 3600000
             : amount * 86400000;

    if (ms > 7 * 24 * 3600000) return toast('Maks hatÄ±rlatma sÃ¼resi 7 gÃ¼ndÃ¼r', 'error');
    if (ms < 5000) return toast('En az 5 saniye sÃ¼re girin', 'error');

    const label = unit === 's' ? `${amount} saniye` : unit === 'm' ? `${amount} dakika` : unit === 'h' ? `${amount} saat` : `${amount} gÃ¼n`;
    toast(`â° HatÄ±rlatÄ±cÄ± kuruldu: ${label} sonra`, 'success');

    setTimeout(() => {
      socket.emit('message:send', {
        channelId: chanId, serverId: srvId,
        content: `â° **HatÄ±rlatÄ±cÄ±:** ${text}`,
      });
    }, ms);
  }

})();


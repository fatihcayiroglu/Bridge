// client/js/app.js â€” Uygulama giriÅŸ noktasÄ± (koordinatÃ¶r)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Bu dosya artÄ±k sadece dokÃ¼mantasyon ve geÃ§-baÄŸlama kodu iÃ§erir.
// TÃ¼m feature kodu core/*.js dosyalarÄ±ndadÄ±r.
//
// YÃ¼kleme sÄ±rasÄ± (scripts/build.js CHUNKS tanÄ±mÄ±na bakÄ±n):
//   chunk-boot     â†’ error-boundary, utils, theme, i18n, state,
//                    globals, auth
//   chunk-core     â†’ offline, servers, channel-list, messages,
//                    upload, members, socket, ui, settings, emoji
//   chunk-comms    â†’ dm, dm-call, group-dm, voice, emoji-picker
//   chunk-webrtc   â†’ noise-suppression, webrtc-sfu, webrtc, video
//   chunk-features â†’ server-settings, discord-ui-kit, channel-perms,
//                    e2e, ai, search, friends, moderation, ...
//   chunk-pages    â†’ app (bu dosya), federation, threads, slash, ...
//   chunk-heavy    â†’ discord-import, bot-marketplace, admin
//   chunk-compat   â†’ v41, v42, v43, v44 modÃ¼lleri
//
// switchDmTab â†’ core/dm.js'e taÅŸÄ±ndÄ±
// Klavye kÄ±sayollarÄ± â†’ core/globals.js'e taÅŸÄ±ndÄ±
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Group DM socket olaylarÄ±nÄ± socket hazÄ±r olunca baÄŸla
document.addEventListener('bridge:socket-ready', () => {
  if (typeof bindGroupDmSocketEvents === 'function' && typeof socket !== 'undefined') {
    bindGroupDmSocketEvents(socket);
  }
});


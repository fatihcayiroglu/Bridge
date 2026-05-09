// core/messages.js — MODÜLE BÖLÜNMÜŞTÜR (Sprint 9)
// Bu dosya artık yalnızca geriye dönük uyumluluk için tutulmaktadır.
// Tüm gerçek implementasyon core/messages/ altındadır:
//
//   messages/scroll.js    — kanal scroll hafızası, initInfiniteScroll
//   messages/loader.js    — loadMessages, loadOlderMessages
//   messages/renderer.js  — renderMessage, _populateMsgEl, showEditHistory
//   messages/reactions.js — renderReactionsHtml, reactToMessage, quickReact
//   messages/input.js     — sendMessage, formatText, edit, search, translate, typing
//   messages/embeds.js    — renderEmbed, renderComponents, handleComponentClick
//
// index.html'de bu dosya yerine messages/ altındaki modüller yüklenir.
// Bakım notu: yeni özellikler uygun alt modüle eklenmelidir.

export const messagesReady = true;

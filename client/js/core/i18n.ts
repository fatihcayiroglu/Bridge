// client/js/core/i18n.js
// TR / EN / DE / FR dil sistemi
// KullanÄ±m:
//   i18n.t('send')                   â†’ "GÃ¶nder" veya "Send"
//   i18n.setLang('en')               â†’ dili deÄŸiÅŸtir + DOM'u gÃ¼ncelle
//   <span data-i18n="send"></span>    â†’ otomatik Ã§evrilir
//   data-tip-i18n="send"             â†’ tooltip Ã§evrilir
//   placeholder-i18n="search"        â†’ placeholder Ã§evrilir

'use strict';

(function (global) {

// â”€â”€ Ã‡eviri tablolarÄ± â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LANGS = {

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TÃœRKÃ‡E (varsayÄ±lan)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
tr: {
  // Auth
  'sign_in':              'GiriÅŸ Yap',
  'create_account':       'Hesap OluÅŸtur',
  'username':             'KullanÄ±cÄ± AdÄ±',
  'display_name':         'GÃ¶rÃ¼nen Ad',
  'password':             'Åifre',
  'password_hint':        'min. 6 karakter',
  'username_hint':        'harf, rakam, alt Ã§izgi',
  'tagline':              'Herkesle, her yerden baÄŸlan',

  // Genel UI
  'loading':              'YÃ¼kleniyorâ€¦',
  'cancel':               'Ä°ptal',
  'close':                'Kapat',
  'save':                 'Kaydet',
  'create':               'OluÅŸtur',
  'send':                 'GÃ¶nder',
  'copy':                 'Kopyala',
  'share':                'PaylaÅŸ',
  'search':               'Ara',
  'search_placeholder':   'Aramak iÃ§in yazmaya baÅŸlayÄ±nâ€¦',
  'invite':               'Davet Et',
  'invite_link':          'Davet Linki',
  'invite_code':          'Davet Kodu',
  'join_via_invite':      'Davet ile KatÄ±l',

  // Navigasyon
  'servers':              'Sunucular',
  'channels':             'Kanallar',
  'chat':                 'Sohbet',
  'members':              'Ãœyeler',
  'profile':              'Profil',
  'friends':              'ArkadaÅŸlar',
  'direct_messages':      'Direkt Mesajlar',
  'settings':             'Ayarlar',

  // Sunucu
  'add_join_server':      'Sunucu Ekle / KatÄ±l',
  'create_server':        'Sunucu OluÅŸtur',
  'join_server':          'Sunucuya KatÄ±l',
  'server_name':          'Sunucu AdÄ±',
  'server_id':            'Sunucu ID',
  'from_template':        'Åablondan',
  'join_by_id':           'ID ile KatÄ±l',
  'icon_emoji':           'Ä°kon (emoji)',
  'select_channel':       'BaÅŸlamak iÃ§in bir kanal seÃ§',
  'select_channel_left':  'Sohbet baÅŸlatmak iÃ§in soldan bir kanal seÃ§.',
  'welcome_to_bridge':    'Bridge\'e HoÅŸ Geldin',
  'select_conversation':  'Sohbet seÃ§',

  // AraÃ§ Ã§ubuÄŸu tooltip'leri
  'tip_add_server':       'Sunucu Ekle / KatÄ±l',
  'tip_profile':          'Profil',
  'tip_friends':          'ArkadaÅŸlar',
  'tip_dm':               'Direkt Mesajlar',
  'tip_mute':             'Sustur',
  'tip_deafen':           'Sesi Kapat',
  'tip_activity':         'Aktivite Durumu',
  'tip_e2e':              'E2E Åifreleme',
  'tip_federation':       'Federasyon â€” Uzak Sunucular',
  'tip_theme':            'TemayÄ± DeÄŸiÅŸtir',
  'tip_settings':         'Ayarlar',
  'tip_members':          'Ãœyeler',
  'tip_pins':             'SabitlenmiÅŸ Mesajlar',
  'tip_poll':             'Anket OluÅŸtur',
  'tip_invite':           'Davet',
  'tip_files':            'Dosya ArÅŸivi',
  'tip_schedule':         'Mesaj Zamanla',
  'tip_bridge':           'Kanal Bridge\'i',
  'tip_discover':         'Sunucu KeÅŸfet',
  'tip_bots':             'Bot Marketi',
  'tip_ai_summary':       'ğŸ¤– AI Kanal Ã–zeti',
  'tip_search':           'Ara',
  'tip_attach':           'Dosya Ekle (2 GB\'a kadar)',
  'tip_voice_msg':        'Sesli Mesaj',
  'tip_emoji':            'Emoji, GIF ve Sunucu GIF\'leri',
  'tip_server_emoji':     'Sunucu Emojileri',
  'tip_send':             'GÃ¶nder',
  'tip_video':            'Video',
  'tip_screenshare':      'Ekran PaylaÅŸ',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'AyrÄ±l',
  'tip_fullscreen':       'Tam Ekran',
  'tip_compact':          'KÃ¼Ã§Ã¼k Mod',
  'tip_mic':              'Mikrofon',
  'tip_speaker':          'Sesi Kapat',
  'tip_stop_share':       'PaylaÅŸÄ±mÄ± Durdur',
  'tip_audio_call':       'Ses AramasÄ±',
  'tip_video_call':       'GÃ¶rÃ¼ntÃ¼lÃ¼ Arama',
  'tip_e2e_call':         'Gizli Mod (E2EE)',
  'tip_reply_suggest':    'ğŸ’¡ YanÄ±t Ã–nerisi',

  // Mesaj kutusu
  'msg_placeholder':      'Mesaj gÃ¶nder',
  'msg_e2e_notice':       'UÃ§tan uca ÅŸifreli â€” Sunucu bu mesajlarÄ± okuyamaz',
  'search_messages':      'Bu kanalda mesaj araâ€¦',

  // Ekran paylaÅŸÄ±mÄ± kalite
  'screen_loading':       'Ekran yÃ¼kleniyorâ€¦',
  'quality_hd':           'HD',
  'quality_note':         "Ãœst kaliteler burada herkese bedava âœ¦",
  'quality_free':         'BEDAVA',
  'quality_max':          'En yÃ¼ksek kalite â€¢ 8 Mbps',
  'quality_high':         'YÃ¼ksek kalite â€¢ 5 Mbps',
  'quality_balanced':     'Dengeli kalite â€¢ 3 Mbps',
  'quality_hd_low':       'HD (DÃ¼ÅŸÃ¼k bant)',
  'quality_slow':         'YavaÅŸ baÄŸlantÄ±lar iÃ§in â€¢ 1.5 Mbps',

  // Ses kanalÄ±
  'voice_channel':        'Ses KanalÄ±',

  // ZamanlanmÄ±ÅŸ mesajlar
  'scheduled_messages':   'ZamanlanmÄ±ÅŸ Mesajlar',
  'send_date_time':       'GÃ¶nderme Tarihi & Saati',
  'duration':             'SÃ¼re',
  'upload':               'YÃ¼kle',

  // GIF / dosya
  'server_gif_desc':      'Bu sunucuya Ã¶zel GIF koleksiyonu. Herkes kullanabilir, admin ekleyip silebilir.',
  'server_files_desc':    'Bu kanalda paylaÅŸÄ±lan tÃ¼m dosyalar',

  // DM
  'all':                  'TÃ¼mÃ¼',
  'message':              'Mesaj',
  'groups':               'Gruplar',
  'set_status':           'Durum Ayarla',
  'mute':                 'Sustur',

  // Bridge
  'active_bridges':       "Aktif Bridge'ler",
  'current_channel':      'Åu anki kanal:',
  'no_user_selected':     'KullanÄ±cÄ± seÃ§ilmedi',

  // Ayarlar
  'settings_title':       'Ayarlar',
  'settings_saved':       'Ayarlar kaydedildi',
  'settings_error':       'Ayarlar kaydedilemedi',
  'lang_toggle':          'English',   // toggle butonunun gÃ¶stereceÄŸi
  'lang_toggle_tip':      'Switch to English',

  // Admin
  'admin_panel':          'âš™ï¸ Admin Paneli',
  'ip_bans':              'ğŸš« IP BanlarÄ±',

  // Hata mesajlarÄ±
  'error_generic':        'Bir hata oluÅŸtu. LÃ¼tfen tekrar dene.',
  'error_crash_title':    'Bir ÅŸeyler ters gitti',
  'error_crash_desc':     'Uygulama beklenmedik bir hatayla karÅŸÄ±laÅŸtÄ±. SayfayÄ± yenileyerek tekrar dene.',
  'error_crash_reload':   'SayfayÄ± Yenile',
  'error_network':        'Sunucuya baÄŸlanÄ±lamÄ±yor.',
  'error_unauthorized':   'Bu iÅŸlem iÃ§in giriÅŸ yapman gerekiyor.',
  'error_forbidden':      'Bu iÅŸlem iÃ§in yetkin yok.',
  'error_not_found':      'AradÄ±ÄŸÄ±n iÃ§erik bulunamadÄ±.',
  'error_ratelimit':      'Ã‡ok fazla istek. Biraz bekle.',
  'error_upload_size':    'Dosya Ã§ok bÃ¼yÃ¼k.',
  'error_server':         'Sunucu hatasÄ±. Tekrar dene.',

  // Bildirimler
  'notif_message':        'Yeni mesaj',
  'notif_mention':        'Seni etiketledi',
  'notif_friend_req':     'ArkadaÅŸlÄ±k isteÄŸi',
  'notif_server_invite':  'Sunucu daveti',
  'notif_reply':          'MesajÄ±na yanÄ±t verdi',

  // Moderasyon
  'kick':                 'At',
  'ban':                  'Yasakla',
  'timeout':              'Sustur',
  'unban':                'YasaÄŸÄ± KaldÄ±r',
  'warn':                 'Uyar',
  'reason':               'Sebep',
  'mod_log':              'Moderasyon KaydÄ±',

  // Roller
  'roles':                'Roller',
  'add_role':             'Rol Ekle',
  'role_name':            'Rol AdÄ±',
  'role_color':           'Renk',
  'permissions':          'Ä°zinler',

  // Kanal tipleri
  'channel_text':         'YazÄ± KanalÄ±',
  'channel_voice':        'Ses KanalÄ±',
  'channel_announcement': 'Duyuru KanalÄ±',
  'channel_stage':        'Sahne',

  // Mesaj eylemleri
  'edit':                 'DÃ¼zenle',
  'delete':               'Sil',
  'reply':                'YanÄ±tla',
  'pin':                  'Sabitle',
  'unpin':                'Sabitlemeyi KaldÄ±r',
  'react':                'Tepki Ver',
  'forward':              'Ä°let',
  'mark_unread':          'OkunmadÄ± Ä°ÅŸaretle',
  'copy_link':            'Mesaj Linkini Kopyala',

  // Genel eylemler
  'confirm':              'Onayla',
  'confirm_delete':       'Silmek istediÄŸinden emin misin?',
  'yes_delete':           'Evet, Sil',
  'no_keep':              'HayÄ±r, KalsÄ±n',
  'leave_server':         'AyrÄ±l',
  'confirm_leave':        'Sunucudan ayrÄ±lmak istediÄŸinden emin misin?',
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENGLISH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
en: {
  // Auth
  'sign_in':              'Sign In',
  'create_account':       'Create Account',
  'username':             'Username',
  'display_name':         'Display Name',
  'password':             'Password',
  'password_hint':        'min. 6 characters',
  'username_hint':        'letters, numbers, underscore only',
  'tagline':              'Connect with anyone, anywhere',

  // General UI
  'loading':              'Loadingâ€¦',
  'cancel':               'Cancel',
  'close':                'Close',
  'save':                 'Save',
  'create':               'Create',
  'send':                 'Send',
  'copy':                 'Copy',
  'share':                'Share',
  'search':               'Search',
  'search_placeholder':   'Start typing to searchâ€¦',
  'invite':               'Invite',
  'invite_link':          'Invite Link',
  'invite_code':          'Invite Code',
  'join_via_invite':      'Join via Invite',

  // Navigation
  'servers':              'Servers',
  'channels':             'Channels',
  'chat':                 'Chat',
  'members':              'Members',
  'profile':              'Profile',
  'friends':              'Friends',
  'direct_messages':      'Direct Messages',
  'settings':             'Settings',

  // Server
  'add_join_server':      'Add / Join Server',
  'create_server':        'Create Server',
  'join_server':          'Join Server',
  'server_name':          'Server Name',
  'server_id':            'Server ID',
  'from_template':        'From Template',
  'join_by_id':           'Join by ID',
  'icon_emoji':           'Icon (emoji)',
  'select_channel':       'Select a channel to start',
  'select_channel_left':  'Select a channel from the left to start chatting.',
  'welcome_to_bridge':    'Welcome to Bridge',
  'select_conversation':  'Select a conversation',

  // Toolbar tooltips
  'tip_add_server':       'Add / Join Server',
  'tip_profile':          'Profile',
  'tip_friends':          'Friends',
  'tip_dm':               'Direct Messages',
  'tip_mute':             'Mute',
  'tip_deafen':           'Deafen',
  'tip_activity':         'Activity Status',
  'tip_e2e':              'E2E Encryption',
  'tip_federation':       'Federation â€” Remote Servers',
  'tip_theme':            'Toggle Theme',
  'tip_settings':         'Settings',
  'tip_members':          'Members',
  'tip_pins':             'Pinned Messages',
  'tip_poll':             'Create Poll',
  'tip_invite':           'Invite',
  'tip_files':            'File Archive',
  'tip_schedule':         'Schedule Message',
  'tip_bridge':           'Channel Bridge',
  'tip_discover':         'Discover Servers',
  'tip_bots':             'Bot Marketplace',
  'tip_ai_summary':       'ğŸ¤– AI Channel Summary',
  'tip_search':           'Search',
  'tip_attach':           'Attach File (up to 2GB)',
  'tip_voice_msg':        'Voice Message',
  'tip_emoji':            'Emoji, GIF & Server GIFs',
  'tip_server_emoji':     'Server Emojis',
  'tip_send':             'Send',
  'tip_video':            'Video',
  'tip_screenshare':      'Share Screen',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'Leave',
  'tip_fullscreen':       'Full Screen',
  'tip_compact':          'Compact Mode',
  'tip_mic':              'Microphone',
  'tip_speaker':          'Deafen',
  'tip_stop_share':       'Stop Sharing',
  'tip_audio_call':       'Audio Call',
  'tip_video_call':       'Video Call',
  'tip_e2e_call':         'Private Mode (E2EE)',
  'tip_reply_suggest':    'ğŸ’¡ Reply Suggestion',

  // Message box
  'msg_placeholder':      'Send a message',
  'msg_e2e_notice':       'End-to-end encrypted â€” Server cannot read these messages',
  'search_messages':      'Search messages in this channelâ€¦',

  // Screen share quality
  'screen_loading':       'Loading screenâ€¦',
  'quality_hd':           'HD',
  'quality_note':         'Premium qualities are free for everyone here âœ¦',
  'quality_free':         'FREE',
  'quality_max':          'Highest quality â€¢ 8 Mbps',
  'quality_high':         'High quality â€¢ 5 Mbps',
  'quality_balanced':     'Balanced quality â€¢ 3 Mbps',
  'quality_hd_low':       'HD (Low bandwidth)',
  'quality_slow':         'For slow connections â€¢ 1.5 Mbps',

  // Voice channel
  'voice_channel':        'Voice Channel',

  // Scheduled messages
  'scheduled_messages':   'Scheduled Messages',
  'send_date_time':       'Send Date & Time',
  'duration':             'Duration',
  'upload':               'Upload',

  // GIF / files
  'server_gif_desc':      'Server-exclusive GIF collection. Everyone can use, admins can add/remove.',
  'server_files_desc':    'All files shared in this channel',

  // DM
  'all':                  'All',
  'message':              'Message',
  'groups':               'Groups',
  'set_status':           'Set Status',
  'mute':                 'Mute',

  // Bridge
  'active_bridges':       'Active Bridges',
  'current_channel':      'Current channel:',
  'no_user_selected':     'No user selected',

  // Settings
  'settings_title':       'Settings',
  'settings_saved':       'Settings saved',
  'settings_error':       'Could not save settings',
  'lang_toggle':          'TÃ¼rkÃ§e',
  'lang_toggle_tip':      'TÃ¼rkÃ§e\'ye geÃ§',

  // Admin
  'admin_panel':          'âš™ï¸ Admin Panel',
  'ip_bans':              'ğŸš« IP Bans',

  // Error messages
  'error_generic':        'Something went wrong. Please try again.',
  'error_crash_title':    'Something went wrong',
  'error_crash_desc':     'The app encountered an unexpected error. Try refreshing the page.',
  'error_crash_reload':   'Refresh Page',
  'error_network':        'Cannot connect to server.',
  'error_unauthorized':   'You need to sign in to do this.',
  'error_forbidden':      'You don\'t have permission to do this.',
  'error_not_found':      'Content not found.',
  'error_ratelimit':      'Too many requests. Please wait.',
  'error_upload_size':    'File is too large.',
  'error_server':         'Server error. Please try again.',

  // Notifications
  'notif_message':        'New message',
  'notif_mention':        'mentioned you',
  'notif_friend_req':     'Friend request',
  'notif_server_invite':  'Server invite',
  'notif_reply':          'replied to your message',

  // Moderation
  'kick':                 'Kick',
  'ban':                  'Ban',
  'timeout':              'Timeout',
  'unban':                'Unban',
  'warn':                 'Warn',
  'reason':               'Reason',
  'mod_log':              'Moderation Log',

  // Roles
  'roles':                'Roles',
  'add_role':             'Add Role',
  'role_name':            'Role Name',
  'role_color':           'Color',
  'permissions':          'Permissions',

  // Channel types
  'channel_text':         'Text Channel',
  'channel_voice':        'Voice Channel',
  'channel_announcement': 'Announcement Channel',
  'channel_stage':        'Stage',

  // Message actions
  'edit':                 'Edit',
  'delete':               'Delete',
  'reply':                'Reply',
  'pin':                  'Pin',
  'unpin':                'Unpin',
  'react':                'React',
  'forward':              'Forward',
  'mark_unread':          'Mark as Unread',
  'copy_link':            'Copy Message Link',

  // General actions
  'confirm':              'Confirm',
  'confirm_delete':       'Are you sure you want to delete this?',
  'yes_delete':           'Yes, Delete',
  'no_keep':              'No, Keep It',
  'leave_server':         'Leave',
  'confirm_leave':        'Are you sure you want to leave this server?',
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DEUTSCH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
de: {
  'sign_in':              'Anmelden',
  'create_account':       'Konto erstellen',
  'username':             'Benutzername',
  'display_name':         'Anzeigename',
  'password':             'Passwort',
  'password_hint':        'mind. 6 Zeichen',
  'username_hint':        'Buchstaben, Zahlen, Unterstrich',
  'tagline':              'Mit jedem verbinden, Ã¼berall',
  'loading':              'Ladenâ€¦',
  'cancel':               'Abbrechen',
  'close':                'SchlieÃŸen',
  'save':                 'Speichern',
  'create':               'Erstellen',
  'send':                 'Senden',
  'copy':                 'Kopieren',
  'share':                'Teilen',
  'search':               'Suchen',
  'search_placeholder':   'Tippen zum Suchenâ€¦',
  'invite':               'Einladen',
  'invite_link':          'Einladungslink',
  'invite_code':          'Einladungscode',
  'join_via_invite':      'Mit Einladung beitreten',
  'servers':              'Server',
  'channels':             'KanÃ¤le',
  'chat':                 'Chat',
  'members':              'Mitglieder',
  'profile':              'Profil',
  'friends':              'Freunde',
  'direct_messages':      'Direktnachrichten',
  'settings':             'Einstellungen',
  'add_join_server':      'Server hinzufÃ¼gen / beitreten',
  'create_server':        'Server erstellen',
  'join_server':          'Server beitreten',
  'server_name':          'Servername',
  'server_id':            'Server-ID',
  'from_template':        'Aus Vorlage',
  'join_by_id':           'Per ID beitreten',
  'icon_emoji':           'Symbol (Emoji)',
  'select_channel':       'Kanal auswÃ¤hlen',
  'select_channel_left':  'WÃ¤hle links einen Kanal zum Chatten.',
  'welcome_to_bridge':    'Willkommen bei Bridge',
  'select_conversation':  'GesprÃ¤ch auswÃ¤hlen',
  'tip_add_server':       'Server hinzufÃ¼gen / beitreten',
  'tip_profile':          'Profil',
  'tip_friends':          'Freunde',
  'tip_dm':               'Direktnachrichten',
  'tip_mute':             'Stummschalten',
  'tip_deafen':           'Ton aus',
  'tip_activity':         'AktivitÃ¤tsstatus',
  'tip_e2e':              'E2E-VerschlÃ¼sselung',
  'tip_federation':       'Verbund â€” Remote-Server',
  'tip_theme':            'Thema wechseln',
  'tip_settings':         'Einstellungen',
  'tip_members':          'Mitglieder',
  'tip_pins':             'Angeheftete Nachrichten',
  'tip_poll':             'Umfrage erstellen',
  'tip_invite':           'Einladen',
  'tip_files':            'Dateiarchiv',
  'tip_schedule':         'Nachricht planen',
  'tip_bridge':           'Kanal-Bridge',
  'tip_discover':         'Server entdecken',
  'tip_bots':             'Bot-Marktplatz',
  'tip_ai_summary':       'ğŸ¤– KI-Kanalzusammenfassung',
  'tip_search':           'Suchen',
  'tip_attach':           'Datei anhÃ¤ngen (bis zu 2 GB)',
  'tip_voice_msg':        'Sprachnachricht',
  'tip_emoji':            'Emoji, GIF & Server-GIFs',
  'tip_server_emoji':     'Server-Emojis',
  'tip_send':             'Senden',
  'tip_video':            'Video',
  'tip_screenshare':      'Bildschirm teilen',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'Verlassen',
  'tip_fullscreen':       'Vollbild',
  'msg_placeholder':      'Nachricht senden',
  'msg_e2e_notice':       'Ende-zu-Ende-verschlÃ¼sselt â€” Server kann nicht mitlesen',
  'voice_channel':        'Sprachkanal',
  'all':                  'Alle',
  'message':              'Nachricht',
  'groups':               'Gruppen',
  'set_status':           'Status setzen',
  'mute':                 'Stummschalten',
  'settings_title':       'Einstellungen',
  'settings_saved':       'Einstellungen gespeichert',
  'settings_error':       'Einstellungen konnten nicht gespeichert werden',
  'lang_toggle':          'English',
  'lang_toggle_tip':      'Sprache wechseln',
  'admin_panel':          'âš™ï¸ Admin-Panel',
  'ip_bans':              'ğŸš« IP-Sperren',
  'error_generic':        'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
  'error_crash_title':    'Etwas ist schiefgelaufen',
  'error_crash_desc':     'Die App ist auf einen unerwarteten Fehler gestoÃŸen. Lade die Seite neu.',
  'error_crash_reload':   'Seite neu laden',
  'error_network':        'Verbindung zum Server nicht mÃ¶glich.',
  'error_unauthorized':   'Anmeldung erforderlich.',
  'error_forbidden':      'Keine Berechtigung.',
  'error_not_found':      'Inhalt nicht gefunden.',
  'error_ratelimit':      'Zu viele Anfragen. Bitte warten.',
  'error_upload_size':    'Datei ist zu groÃŸ.',
  'error_server':         'Serverfehler. Bitte erneut versuchen.',
  'kick':                 'Kicken',
  'ban':                  'Bannen',
  'timeout':              'Auszeit',
  'unban':                'Entbannen',
  'warn':                 'Verwarnen',
  'reason':               'Grund',
  'mod_log':              'Moderationsprotokoll',
  'roles':                'Rollen',
  'add_role':             'Rolle hinzufÃ¼gen',
  'role_name':            'Rollenname',
  'role_color':           'Farbe',
  'permissions':          'Berechtigungen',
  'channel_text':         'Textkanal',
  'channel_voice':        'Sprachkanal',
  'channel_announcement': 'AnkÃ¼ndigungskanal',
  'channel_stage':        'BÃ¼hne',
  'edit':                 'Bearbeiten',
  'delete':               'LÃ¶schen',
  'reply':                'Antworten',
  'pin':                  'Anheften',
  'unpin':                'LÃ¶sen',
  'react':                'Reagieren',
  'forward':              'Weiterleiten',
  'mark_unread':          'Als ungelesen markieren',
  'copy_link':            'Nachrichtenlink kopieren',
  'confirm':              'BestÃ¤tigen',
  'confirm_delete':       'Soll das wirklich gelÃ¶scht werden?',
  'yes_delete':           'Ja, lÃ¶schen',
  'no_keep':              'Nein, behalten',
  'leave_server':         'Verlassen',
  'confirm_leave':        'Diesen Server wirklich verlassen?',
},

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FRANÃ‡AIS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
fr: {
  'sign_in':              'Se connecter',
  'create_account':       'CrÃ©er un compte',
  'username':             'Nom d\'utilisateur',
  'display_name':         'Nom affichÃ©',
  'password':             'Mot de passe',
  'password_hint':        'min. 6 caractÃ¨res',
  'username_hint':        'lettres, chiffres, underscore',
  'tagline':              'Connectez-vous avec n\'importe qui, partout',
  'loading':              'Chargementâ€¦',
  'cancel':               'Annuler',
  'close':                'Fermer',
  'save':                 'Enregistrer',
  'create':               'CrÃ©er',
  'send':                 'Envoyer',
  'copy':                 'Copier',
  'share':                'Partager',
  'search':               'Rechercher',
  'search_placeholder':   'Commencez Ã  taperâ€¦',
  'invite':               'Inviter',
  'invite_link':          'Lien d\'invitation',
  'invite_code':          'Code d\'invitation',
  'join_via_invite':      'Rejoindre par invitation',
  'servers':              'Serveurs',
  'channels':             'Canaux',
  'chat':                 'Discussion',
  'members':              'Membres',
  'profile':              'Profil',
  'friends':              'Amis',
  'direct_messages':      'Messages directs',
  'settings':             'ParamÃ¨tres',
  'add_join_server':      'Ajouter / rejoindre un serveur',
  'create_server':        'CrÃ©er un serveur',
  'join_server':          'Rejoindre un serveur',
  'server_name':          'Nom du serveur',
  'server_id':            'ID du serveur',
  'from_template':        'Depuis un modÃ¨le',
  'join_by_id':           'Rejoindre par ID',
  'icon_emoji':           'IcÃ´ne (emoji)',
  'select_channel':       'SÃ©lectionnez un canal',
  'select_channel_left':  'Choisissez un canal Ã  gauche pour discuter.',
  'welcome_to_bridge':    'Bienvenue sur Bridge',
  'select_conversation':  'SÃ©lectionner une conversation',
  'tip_add_server':       'Ajouter / rejoindre un serveur',
  'tip_profile':          'Profil',
  'tip_friends':          'Amis',
  'tip_dm':               'Messages directs',
  'tip_mute':             'Muet',
  'tip_deafen':           'Couper le son',
  'tip_activity':         'Statut d\'activitÃ©',
  'tip_e2e':              'Chiffrement E2E',
  'tip_federation':       'FÃ©dÃ©ration â€” Serveurs distants',
  'tip_theme':            'Changer le thÃ¨me',
  'tip_settings':         'ParamÃ¨tres',
  'tip_members':          'Membres',
  'tip_pins':             'Messages Ã©pinglÃ©s',
  'tip_poll':             'CrÃ©er un sondage',
  'tip_invite':           'Inviter',
  'tip_files':            'Archive de fichiers',
  'tip_schedule':         'Planifier un message',
  'tip_bridge':           'Pont de canal',
  'tip_discover':         'DÃ©couvrir des serveurs',
  'tip_bots':             'MarchÃ© de bots',
  'tip_ai_summary':       'ğŸ¤– RÃ©sumÃ© IA du canal',
  'tip_search':           'Rechercher',
  'tip_attach':           'Joindre un fichier (jusqu\'Ã  2 Go)',
  'tip_voice_msg':        'Message vocal',
  'tip_emoji':            'Emoji, GIF et GIFs du serveur',
  'tip_server_emoji':     'Emojis du serveur',
  'tip_send':             'Envoyer',
  'tip_video':            'VidÃ©o',
  'tip_screenshare':      'Partager l\'Ã©cran',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'Quitter',
  'tip_fullscreen':       'Plein Ã©cran',
  'msg_placeholder':      'Envoyer un message',
  'msg_e2e_notice':       'ChiffrÃ© de bout en bout â€” le serveur ne peut pas lire ces messages',
  'voice_channel':        'Canal vocal',
  'all':                  'Tous',
  'message':              'Message',
  'groups':               'Groupes',
  'set_status':           'DÃ©finir le statut',
  'mute':                 'Muet',
  'settings_title':       'ParamÃ¨tres',
  'settings_saved':       'ParamÃ¨tres enregistrÃ©s',
  'settings_error':       'Impossible d\'enregistrer les paramÃ¨tres',
  'lang_toggle':          'TÃ¼rkÃ§e',
  'lang_toggle_tip':      'Changer de langue',
  'admin_panel':          'âš™ï¸ Panneau d\'administration',
  'ip_bans':              'ğŸš« Bannissements IP',
  'error_generic':        'Une erreur s\'est produite. Veuillez rÃ©essayer.',
  'error_crash_title':    'Une erreur s\'est produite',
  'error_crash_desc':     'L\'application a rencontrÃ© une erreur inattendue. Essayez de rafraÃ®chir la page.',
  'error_crash_reload':   'RafraÃ®chir la page',
  'error_network':        'Impossible de se connecter au serveur.',
  'error_unauthorized':   'Vous devez vous connecter.',
  'error_forbidden':      'Vous n\'avez pas la permission.',
  'error_not_found':      'Contenu introuvable.',
  'error_ratelimit':      'Trop de requÃªtes. Veuillez patienter.',
  'error_upload_size':    'Le fichier est trop volumineux.',
  'error_server':         'Erreur serveur. Veuillez rÃ©essayer.',
  'kick':                 'Expulser',
  'ban':                  'Bannir',
  'timeout':              'Mettre en pause',
  'unban':                'DÃ©bannir',
  'warn':                 'Avertir',
  'reason':               'Raison',
  'mod_log':              'Journal de modÃ©ration',
  'roles':                'RÃ´les',
  'add_role':             'Ajouter un rÃ´le',
  'role_name':            'Nom du rÃ´le',
  'role_color':           'Couleur',
  'permissions':          'Permissions',
  'channel_text':         'Canal textuel',
  'channel_voice':        'Canal vocal',
  'channel_announcement': 'Canal d\'annonces',
  'channel_stage':        'ScÃ¨ne',
  'edit':                 'Modifier',
  'delete':               'Supprimer',
  'reply':                'RÃ©pondre',
  'pin':                  'Ã‰pingler',
  'unpin':                'DÃ©sÃ©pingler',
  'react':                'RÃ©agir',
  'forward':              'TransfÃ©rer',
  'mark_unread':          'Marquer comme non lu',
  'copy_link':            'Copier le lien du message',
  'confirm':              'Confirmer',
  'confirm_delete':       'Voulez-vous vraiment supprimer ceci ?',
  'yes_delete':           'Oui, supprimer',
  'no_keep':              'Non, garder',
  'leave_server':         'Quitter',
  'confirm_leave':        'Voulez-vous vraiment quitter ce serveur ?',
},

}; // end LANGS

// â”€â”€ Ã‡ekirdek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STORAGE_KEY = 'bridge_lang';
const DEFAULT     = 'tr';
const SUPPORTED   = ['tr', 'en', 'de', 'fr'];

let _lang = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED.includes(saved)) return saved;
  } catch { /**/ }
  const browser = (navigator.language || '').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(browser) ? browser : DEFAULT;
})();

function t(key, fallback) {
  return LANGS[_lang]?.[key] ?? LANGS[DEFAULT]?.[key] ?? fallback ?? key;
}

function lang() { return _lang; }

function setLang(code) {
  if (!SUPPORTED.includes(code)) return;
  _lang = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /**/ }
  document.documentElement.lang = code;
  _applyAll();
  _dispatchChange();
}

function toggleLang() {
  const idx = SUPPORTED.indexOf(_lang);
  setLang(SUPPORTED[(idx + 1) % SUPPORTED.length]);
}

// â”€â”€ DOM uygulama â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Desteklenen attribute'lar:
//   data-i18n="key"               â†’ element.textContent
//   data-i18n-html="key"          â†’ element.innerHTML (dikkatli kullan)
//   data-tip-i18n="key"           â†’ data-tip attribute
//   data-placeholder-i18n="key"   â†’ placeholder attribute
//   data-aria-label-i18n="key"    â†’ aria-label attribute
//   data-i18n-toggle              â†’ dil toggle butonu (lang_toggle key'ini kullanÄ±r)

function _applyAll(root) {
  const scope = root || document;

  // textContent
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });

  // innerHTML (XSS: sadece kendi key'lerimizi koyacaÄŸÄ±z)
  scope.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml;
    el.innerHTML = t(key);
  });

  // data-tip (tooltip)
  scope.querySelectorAll('[data-tip-i18n]').forEach(el => {
    const key = el.dataset.tipI18n;
    el.dataset.tip = t(key);
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', t(key));
  });

  // placeholder
  scope.querySelectorAll('[data-placeholder-i18n]').forEach(el => {
    el.placeholder = t(el.dataset.placeholderI18n);
  });

  // aria-label
  scope.querySelectorAll('[data-aria-label-i18n]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.ariaLabelI18n));
  });

  // toggle butonu
  scope.querySelectorAll('[data-i18n-toggle]').forEach(el => {
    el.textContent  = t('lang_toggle');
    el.title        = t('lang_toggle_tip');
    el.dataset.tip  = t('lang_toggle_tip');
  });
}

// â”€â”€ Event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _dispatchChange() {
  document.dispatchEvent(new CustomEvent('bridge:langchange', { detail: { lang: _lang } }));
}

// DOM hazÄ±r olunca ilk uygulama
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _applyAll());
} else {
  _applyAll();
}

// MutationObserver: dinamik eklenen node'larÄ± da Ã§evir
const _observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      // Kendisi mi?
      if (node.dataset?.i18n || node.dataset?.tipI18n || node.dataset?.placeholderI18n) {
        _applyAll(node.parentElement || document);
      }
      // Alt elemanlarÄ± mÄ±?
      if (node.querySelector?.('[data-i18n],[data-tip-i18n],[data-placeholder-i18n]')) {
        _applyAll(node);
      }
    });
  }
});
_observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const i18n = { t, lang, setLang, toggleLang, apply: _applyAll, LANGS, SUPPORTED };
global.i18n = i18n;

// KÄ±sa alias â€” isteÄŸe baÄŸlÄ±: window.__ = i18n.t
global.__ = (key, fb) => i18n.t(key, fb);

console.log(`[Bridge i18n] Dil yÃ¼klendi: ${_lang}`);

})(window);


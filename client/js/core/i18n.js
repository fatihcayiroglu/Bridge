// client/js/core/i18n.js
// TR / EN / DE / FR dil sistemi
// Kullanım:
//   i18n.t('send')                   → "Gönder" veya "Send"
//   i18n.setLang('en')               → dili değiştir + DOM'u güncelle
//   <span data-i18n="send"></span>    → otomatik çevrilir
//   data-tip-i18n="send"             → tooltip çevrilir
//   placeholder-i18n="search"        → placeholder çevrilir

'use strict';

(function (global) {

// ── Çeviri tabloları ────────────────────────────────────────────

const LANGS = {

// ════════════════════════════════════════
// TÜRKÇE (varsayılan)
// ════════════════════════════════════════
tr: {
  // Auth
  'sign_in':              'Giriş Yap',
  'create_account':       'Hesap Oluştur',
  'username':             'Kullanıcı Adı',
  'display_name':         'Görünen Ad',
  'password':             'Şifre',
  'password_hint':        'min. 6 karakter',
  'username_hint':        'harf, rakam, alt çizgi',
  'tagline':              'Herkesle, her yerden bağlan',

  // Genel UI
  'loading':              'Yükleniyor…',
  'cancel':               'İptal',
  'close':                'Kapat',
  'save':                 'Kaydet',
  'create':               'Oluştur',
  'send':                 'Gönder',
  'copy':                 'Kopyala',
  'share':                'Paylaş',
  'search':               'Ara',
  'search_placeholder':   'Aramak için yazmaya başlayın…',
  'invite':               'Davet Et',
  'invite_link':          'Davet Linki',
  'invite_code':          'Davet Kodu',
  'join_via_invite':      'Davet ile Katıl',

  // Navigasyon
  'servers':              'Sunucular',
  'channels':             'Kanallar',
  'chat':                 'Sohbet',
  'members':              'Üyeler',
  'profile':              'Profil',
  'friends':              'Arkadaşlar',
  'direct_messages':      'Direkt Mesajlar',
  'settings':             'Ayarlar',

  // Sunucu
  'add_join_server':      'Sunucu Ekle / Katıl',
  'create_server':        'Sunucu Oluştur',
  'join_server':          'Sunucuya Katıl',
  'server_name':          'Sunucu Adı',
  'server_id':            'Sunucu ID',
  'from_template':        'Şablondan',
  'join_by_id':           'ID ile Katıl',
  'icon_emoji':           'İkon (emoji)',
  'select_channel':       'Başlamak için bir kanal seç',
  'select_channel_left':  'Sohbet başlatmak için soldan bir kanal seç.',
  'welcome_to_bridge':    'Bridge\'e Hoş Geldin',
  'select_conversation':  'Sohbet seç',

  // Araç çubuğu tooltip'leri
  'tip_add_server':       'Sunucu Ekle / Katıl',
  'tip_profile':          'Profil',
  'tip_friends':          'Arkadaşlar',
  'tip_dm':               'Direkt Mesajlar',
  'tip_mute':             'Sustur',
  'tip_deafen':           'Sesi Kapat',
  'tip_activity':         'Aktivite Durumu',
  'tip_e2e':              'E2E Şifreleme',
  'tip_federation':       'Federasyon — Uzak Sunucular',
  'tip_theme':            'Temayı Değiştir',
  'tip_settings':         'Ayarlar',
  'tip_members':          'Üyeler',
  'tip_pins':             'Sabitlenmiş Mesajlar',
  'tip_poll':             'Anket Oluştur',
  'tip_invite':           'Davet',
  'tip_files':            'Dosya Arşivi',
  'tip_schedule':         'Mesaj Zamanla',
  'tip_bridge':           'Kanal Bridge\'i',
  'tip_discover':         'Sunucu Keşfet',
  'tip_bots':             'Bot Marketi',
  'tip_ai_summary':       '🤖 AI Kanal Özeti',
  'tip_search':           'Ara',
  'tip_attach':           'Dosya Ekle (2 GB\'a kadar)',
  'tip_voice_msg':        'Sesli Mesaj',
  'tip_emoji':            'Emoji, GIF ve Sunucu GIF\'leri',
  'tip_server_emoji':     'Sunucu Emojileri',
  'tip_send':             'Gönder',
  'tip_video':            'Video',
  'tip_screenshare':      'Ekran Paylaş',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'Ayrıl',
  'tip_fullscreen':       'Tam Ekran',
  'tip_compact':          'Küçük Mod',
  'tip_mic':              'Mikrofon',
  'tip_speaker':          'Sesi Kapat',
  'tip_stop_share':       'Paylaşımı Durdur',
  'tip_audio_call':       'Ses Araması',
  'tip_video_call':       'Görüntülü Arama',
  'tip_e2e_call':         'Gizli Mod (E2EE)',
  'tip_reply_suggest':    '💡 Yanıt Önerisi',

  // Mesaj kutusu
  'msg_placeholder':      'Mesaj gönder',
  'msg_e2e_notice':       'Uçtan uca şifreli — Sunucu bu mesajları okuyamaz',
  'search_messages':      'Bu kanalda mesaj ara…',

  // Ekran paylaşımı kalite
  'screen_loading':       'Ekran yükleniyor…',
  'quality_hd':           'HD',
  'quality_note':         "Üst kaliteler burada herkese bedava ✦",
  'quality_free':         'BEDAVA',
  'quality_max':          'En yüksek kalite • 8 Mbps',
  'quality_high':         'Yüksek kalite • 5 Mbps',
  'quality_balanced':     'Dengeli kalite • 3 Mbps',
  'quality_hd_low':       'HD (Düşük bant)',
  'quality_slow':         'Yavaş bağlantılar için • 1.5 Mbps',

  // Ses kanalı
  'voice_channel':        'Ses Kanalı',

  // Zamanlanmış mesajlar
  'scheduled_messages':   'Zamanlanmış Mesajlar',
  'send_date_time':       'Gönderme Tarihi & Saati',
  'duration':             'Süre',
  'upload':               'Yükle',

  // GIF / dosya
  'server_gif_desc':      'Bu sunucuya özel GIF koleksiyonu. Herkes kullanabilir, admin ekleyip silebilir.',
  'server_files_desc':    'Bu kanalda paylaşılan tüm dosyalar',

  // DM
  'all':                  'Tümü',
  'message':              'Mesaj',
  'groups':               'Gruplar',
  'set_status':           'Durum Ayarla',
  'mute':                 'Sustur',

  // Bridge
  'active_bridges':       "Aktif Bridge'ler",
  'current_channel':      'Şu anki kanal:',
  'no_user_selected':     'Kullanıcı seçilmedi',

  // Ayarlar
  'settings_title':       'Ayarlar',
  'settings_saved':       'Ayarlar kaydedildi',
  'settings_error':       'Ayarlar kaydedilemedi',
  'lang_toggle':          'English',   // toggle butonunun göstereceği
  'lang_toggle_tip':      'Switch to English',

  // Admin
  'admin_panel':          '⚙️ Admin Paneli',
  'ip_bans':              '🚫 IP Banları',

  // Hata mesajları
  'error_generic':        'Bir hata oluştu. Lütfen tekrar dene.',
  'error_crash_title':    'Bir şeyler ters gitti',
  'error_crash_desc':     'Uygulama beklenmedik bir hatayla karşılaştı. Sayfayı yenileyerek tekrar dene.',
  'error_crash_reload':   'Sayfayı Yenile',
  'error_network':        'Sunucuya bağlanılamıyor.',
  'error_unauthorized':   'Bu işlem için giriş yapman gerekiyor.',
  'error_forbidden':      'Bu işlem için yetkin yok.',
  'error_not_found':      'Aradığın içerik bulunamadı.',
  'error_ratelimit':      'Çok fazla istek. Biraz bekle.',
  'error_upload_size':    'Dosya çok büyük.',
  'error_server':         'Sunucu hatası. Tekrar dene.',

  // Bildirimler
  'notif_message':        'Yeni mesaj',
  'notif_mention':        'Seni etiketledi',
  'notif_friend_req':     'Arkadaşlık isteği',
  'notif_server_invite':  'Sunucu daveti',
  'notif_reply':          'Mesajına yanıt verdi',

  // Moderasyon
  'kick':                 'At',
  'ban':                  'Yasakla',
  'timeout':              'Sustur',
  'unban':                'Yasağı Kaldır',
  'warn':                 'Uyar',
  'reason':               'Sebep',
  'mod_log':              'Moderasyon Kaydı',

  // Roller
  'roles':                'Roller',
  'add_role':             'Rol Ekle',
  'role_name':            'Rol Adı',
  'role_color':           'Renk',
  'permissions':          'İzinler',

  // Kanal tipleri
  'channel_text':         'Yazı Kanalı',
  'channel_voice':        'Ses Kanalı',
  'channel_announcement': 'Duyuru Kanalı',
  'channel_stage':        'Sahne',

  // Mesaj eylemleri
  'edit':                 'Düzenle',
  'delete':               'Sil',
  'reply':                'Yanıtla',
  'pin':                  'Sabitle',
  'unpin':                'Sabitlemeyi Kaldır',
  'react':                'Tepki Ver',
  'forward':              'İlet',
  'mark_unread':          'Okunmadı İşaretle',
  'copy_link':            'Mesaj Linkini Kopyala',

  // Genel eylemler
  'confirm':              'Onayla',
  'confirm_delete':       'Silmek istediğinden emin misin?',
  'yes_delete':           'Evet, Sil',
  'no_keep':              'Hayır, Kalsın',
  'leave_server':         'Ayrıl',
  'confirm_leave':        'Sunucudan ayrılmak istediğinden emin misin?',
},

// ════════════════════════════════════════
// ENGLISH
// ════════════════════════════════════════
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
  'loading':              'Loading…',
  'cancel':               'Cancel',
  'close':                'Close',
  'save':                 'Save',
  'create':               'Create',
  'send':                 'Send',
  'copy':                 'Copy',
  'share':                'Share',
  'search':               'Search',
  'search_placeholder':   'Start typing to search…',
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
  'tip_federation':       'Federation — Remote Servers',
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
  'tip_ai_summary':       '🤖 AI Channel Summary',
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
  'tip_reply_suggest':    '💡 Reply Suggestion',

  // Message box
  'msg_placeholder':      'Send a message',
  'msg_e2e_notice':       'End-to-end encrypted — Server cannot read these messages',
  'search_messages':      'Search messages in this channel…',

  // Screen share quality
  'screen_loading':       'Loading screen…',
  'quality_hd':           'HD',
  'quality_note':         'Premium qualities are free for everyone here ✦',
  'quality_free':         'FREE',
  'quality_max':          'Highest quality • 8 Mbps',
  'quality_high':         'High quality • 5 Mbps',
  'quality_balanced':     'Balanced quality • 3 Mbps',
  'quality_hd_low':       'HD (Low bandwidth)',
  'quality_slow':         'For slow connections • 1.5 Mbps',

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
  'lang_toggle':          'Türkçe',
  'lang_toggle_tip':      'Türkçe\'ye geç',

  // Admin
  'admin_panel':          '⚙️ Admin Panel',
  'ip_bans':              '🚫 IP Bans',

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

// ════════════════════════════════════════
// DEUTSCH
// ════════════════════════════════════════
de: {
  'sign_in':              'Anmelden',
  'create_account':       'Konto erstellen',
  'username':             'Benutzername',
  'display_name':         'Anzeigename',
  'password':             'Passwort',
  'password_hint':        'mind. 6 Zeichen',
  'username_hint':        'Buchstaben, Zahlen, Unterstrich',
  'tagline':              'Mit jedem verbinden, überall',
  'loading':              'Laden…',
  'cancel':               'Abbrechen',
  'close':                'Schließen',
  'save':                 'Speichern',
  'create':               'Erstellen',
  'send':                 'Senden',
  'copy':                 'Kopieren',
  'share':                'Teilen',
  'search':               'Suchen',
  'search_placeholder':   'Tippen zum Suchen…',
  'invite':               'Einladen',
  'invite_link':          'Einladungslink',
  'invite_code':          'Einladungscode',
  'join_via_invite':      'Mit Einladung beitreten',
  'servers':              'Server',
  'channels':             'Kanäle',
  'chat':                 'Chat',
  'members':              'Mitglieder',
  'profile':              'Profil',
  'friends':              'Freunde',
  'direct_messages':      'Direktnachrichten',
  'settings':             'Einstellungen',
  'add_join_server':      'Server hinzufügen / beitreten',
  'create_server':        'Server erstellen',
  'join_server':          'Server beitreten',
  'server_name':          'Servername',
  'server_id':            'Server-ID',
  'from_template':        'Aus Vorlage',
  'join_by_id':           'Per ID beitreten',
  'icon_emoji':           'Symbol (Emoji)',
  'select_channel':       'Kanal auswählen',
  'select_channel_left':  'Wähle links einen Kanal zum Chatten.',
  'welcome_to_bridge':    'Willkommen bei Bridge',
  'select_conversation':  'Gespräch auswählen',
  'tip_add_server':       'Server hinzufügen / beitreten',
  'tip_profile':          'Profil',
  'tip_friends':          'Freunde',
  'tip_dm':               'Direktnachrichten',
  'tip_mute':             'Stummschalten',
  'tip_deafen':           'Ton aus',
  'tip_activity':         'Aktivitätsstatus',
  'tip_e2e':              'E2E-Verschlüsselung',
  'tip_federation':       'Verbund — Remote-Server',
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
  'tip_ai_summary':       '🤖 KI-Kanalzusammenfassung',
  'tip_search':           'Suchen',
  'tip_attach':           'Datei anhängen (bis zu 2 GB)',
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
  'msg_e2e_notice':       'Ende-zu-Ende-verschlüsselt — Server kann nicht mitlesen',
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
  'admin_panel':          '⚙️ Admin-Panel',
  'ip_bans':              '🚫 IP-Sperren',
  'error_generic':        'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
  'error_crash_title':    'Etwas ist schiefgelaufen',
  'error_crash_desc':     'Die App ist auf einen unerwarteten Fehler gestoßen. Lade die Seite neu.',
  'error_crash_reload':   'Seite neu laden',
  'error_network':        'Verbindung zum Server nicht möglich.',
  'error_unauthorized':   'Anmeldung erforderlich.',
  'error_forbidden':      'Keine Berechtigung.',
  'error_not_found':      'Inhalt nicht gefunden.',
  'error_ratelimit':      'Zu viele Anfragen. Bitte warten.',
  'error_upload_size':    'Datei ist zu groß.',
  'error_server':         'Serverfehler. Bitte erneut versuchen.',
  'kick':                 'Kicken',
  'ban':                  'Bannen',
  'timeout':              'Auszeit',
  'unban':                'Entbannen',
  'warn':                 'Verwarnen',
  'reason':               'Grund',
  'mod_log':              'Moderationsprotokoll',
  'roles':                'Rollen',
  'add_role':             'Rolle hinzufügen',
  'role_name':            'Rollenname',
  'role_color':           'Farbe',
  'permissions':          'Berechtigungen',
  'channel_text':         'Textkanal',
  'channel_voice':        'Sprachkanal',
  'channel_announcement': 'Ankündigungskanal',
  'channel_stage':        'Bühne',
  'edit':                 'Bearbeiten',
  'delete':               'Löschen',
  'reply':                'Antworten',
  'pin':                  'Anheften',
  'unpin':                'Lösen',
  'react':                'Reagieren',
  'forward':              'Weiterleiten',
  'mark_unread':          'Als ungelesen markieren',
  'copy_link':            'Nachrichtenlink kopieren',
  'confirm':              'Bestätigen',
  'confirm_delete':       'Soll das wirklich gelöscht werden?',
  'yes_delete':           'Ja, löschen',
  'no_keep':              'Nein, behalten',
  'leave_server':         'Verlassen',
  'confirm_leave':        'Diesen Server wirklich verlassen?',
},

// ════════════════════════════════════════
// FRANÇAIS
// ════════════════════════════════════════
fr: {
  'sign_in':              'Se connecter',
  'create_account':       'Créer un compte',
  'username':             'Nom d\'utilisateur',
  'display_name':         'Nom affiché',
  'password':             'Mot de passe',
  'password_hint':        'min. 6 caractères',
  'username_hint':        'lettres, chiffres, underscore',
  'tagline':              'Connectez-vous avec n\'importe qui, partout',
  'loading':              'Chargement…',
  'cancel':               'Annuler',
  'close':                'Fermer',
  'save':                 'Enregistrer',
  'create':               'Créer',
  'send':                 'Envoyer',
  'copy':                 'Copier',
  'share':                'Partager',
  'search':               'Rechercher',
  'search_placeholder':   'Commencez à taper…',
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
  'settings':             'Paramètres',
  'add_join_server':      'Ajouter / rejoindre un serveur',
  'create_server':        'Créer un serveur',
  'join_server':          'Rejoindre un serveur',
  'server_name':          'Nom du serveur',
  'server_id':            'ID du serveur',
  'from_template':        'Depuis un modèle',
  'join_by_id':           'Rejoindre par ID',
  'icon_emoji':           'Icône (emoji)',
  'select_channel':       'Sélectionnez un canal',
  'select_channel_left':  'Choisissez un canal à gauche pour discuter.',
  'welcome_to_bridge':    'Bienvenue sur Bridge',
  'select_conversation':  'Sélectionner une conversation',
  'tip_add_server':       'Ajouter / rejoindre un serveur',
  'tip_profile':          'Profil',
  'tip_friends':          'Amis',
  'tip_dm':               'Messages directs',
  'tip_mute':             'Muet',
  'tip_deafen':           'Couper le son',
  'tip_activity':         'Statut d\'activité',
  'tip_e2e':              'Chiffrement E2E',
  'tip_federation':       'Fédération — Serveurs distants',
  'tip_theme':            'Changer le thème',
  'tip_settings':         'Paramètres',
  'tip_members':          'Membres',
  'tip_pins':             'Messages épinglés',
  'tip_poll':             'Créer un sondage',
  'tip_invite':           'Inviter',
  'tip_files':            'Archive de fichiers',
  'tip_schedule':         'Planifier un message',
  'tip_bridge':           'Pont de canal',
  'tip_discover':         'Découvrir des serveurs',
  'tip_bots':             'Marché de bots',
  'tip_ai_summary':       '🤖 Résumé IA du canal',
  'tip_search':           'Rechercher',
  'tip_attach':           'Joindre un fichier (jusqu\'à 2 Go)',
  'tip_voice_msg':        'Message vocal',
  'tip_emoji':            'Emoji, GIF et GIFs du serveur',
  'tip_server_emoji':     'Emojis du serveur',
  'tip_send':             'Envoyer',
  'tip_video':            'Vidéo',
  'tip_screenshare':      'Partager l\'écran',
  'tip_soundboard':       'Soundboard',
  'tip_leave':            'Quitter',
  'tip_fullscreen':       'Plein écran',
  'msg_placeholder':      'Envoyer un message',
  'msg_e2e_notice':       'Chiffré de bout en bout — le serveur ne peut pas lire ces messages',
  'voice_channel':        'Canal vocal',
  'all':                  'Tous',
  'message':              'Message',
  'groups':               'Groupes',
  'set_status':           'Définir le statut',
  'mute':                 'Muet',
  'settings_title':       'Paramètres',
  'settings_saved':       'Paramètres enregistrés',
  'settings_error':       'Impossible d\'enregistrer les paramètres',
  'lang_toggle':          'Türkçe',
  'lang_toggle_tip':      'Changer de langue',
  'admin_panel':          '⚙️ Panneau d\'administration',
  'ip_bans':              '🚫 Bannissements IP',
  'error_generic':        'Une erreur s\'est produite. Veuillez réessayer.',
  'error_crash_title':    'Une erreur s\'est produite',
  'error_crash_desc':     'L\'application a rencontré une erreur inattendue. Essayez de rafraîchir la page.',
  'error_crash_reload':   'Rafraîchir la page',
  'error_network':        'Impossible de se connecter au serveur.',
  'error_unauthorized':   'Vous devez vous connecter.',
  'error_forbidden':      'Vous n\'avez pas la permission.',
  'error_not_found':      'Contenu introuvable.',
  'error_ratelimit':      'Trop de requêtes. Veuillez patienter.',
  'error_upload_size':    'Le fichier est trop volumineux.',
  'error_server':         'Erreur serveur. Veuillez réessayer.',
  'kick':                 'Expulser',
  'ban':                  'Bannir',
  'timeout':              'Mettre en pause',
  'unban':                'Débannir',
  'warn':                 'Avertir',
  'reason':               'Raison',
  'mod_log':              'Journal de modération',
  'roles':                'Rôles',
  'add_role':             'Ajouter un rôle',
  'role_name':            'Nom du rôle',
  'role_color':           'Couleur',
  'permissions':          'Permissions',
  'channel_text':         'Canal textuel',
  'channel_voice':        'Canal vocal',
  'channel_announcement': 'Canal d\'annonces',
  'channel_stage':        'Scène',
  'edit':                 'Modifier',
  'delete':               'Supprimer',
  'reply':                'Répondre',
  'pin':                  'Épingler',
  'unpin':                'Désépingler',
  'react':                'Réagir',
  'forward':              'Transférer',
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

// ── Çekirdek ────────────────────────────────────────────────────

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

// ── DOM uygulama ────────────────────────────────────────────────
// Desteklenen attribute'lar:
//   data-i18n="key"               → element.textContent
//   data-i18n-html="key"          → element.innerHTML (dikkatli kullan)
//   data-tip-i18n="key"           → data-tip attribute
//   data-placeholder-i18n="key"   → placeholder attribute
//   data-aria-label-i18n="key"    → aria-label attribute
//   data-i18n-toggle              → dil toggle butonu (lang_toggle key'ini kullanır)

function _applyAll(root) {
  const scope = root || document;

  // textContent
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });

  // innerHTML (XSS: sadece kendi key'lerimizi koyacağız)
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

// ── Event ───────────────────────────────────────────────────────

function _dispatchChange() {
  document.dispatchEvent(new CustomEvent('bridge:langchange', { detail: { lang: _lang } }));
}

// DOM hazır olunca ilk uygulama
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _applyAll());
} else {
  _applyAll();
}

// MutationObserver: dinamik eklenen node'ları da çevir
const _observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      // Kendisi mi?
      if (node.dataset?.i18n || node.dataset?.tipI18n || node.dataset?.placeholderI18n) {
        _applyAll(node.parentElement || document);
      }
      // Alt elemanları mı?
      if (node.querySelector?.('[data-i18n],[data-tip-i18n],[data-placeholder-i18n]')) {
        _applyAll(node);
      }
    });
  }
});
_observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

// ── Public API ──────────────────────────────────────────────────

const i18n = { t, lang, setLang, toggleLang, apply: _applyAll, LANGS, SUPPORTED };
global.i18n = i18n;

// Kısa alias — isteğe bağlı: window.__ = i18n.t
global.__ = (key, fb) => i18n.t(key, fb);

console.log(`[Bridge i18n] Dil yüklendi: ${_lang}`);

})(window);

// ─────────────────────────────────────────────────────────────

// IIFE zaten window.i18n ve window.__ atar — shim gerekmez.
// Yeni kod: import { i18n } from './i18n.js';
//           import { t } from './i18n.js';  // destructure
// ─────────────────────────────────────────────────────────────
// i18n nesnesi IIFE içinde oluşturuldu, window.i18n üzerinden eriş.
// ESM tüketicileri için re-export:
export const i18n   = window.i18n;
export const t      = (key, fb) => window.i18n?.t(key, fb);
export const lang   = ()        => window.i18n?.lang();
export const setLang   = (code) => window.i18n?.setLang(code);
export const toggleLang = ()    => window.i18n?.toggleLang();

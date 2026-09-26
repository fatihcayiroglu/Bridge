<!-- client/js/core/CommandPalettePanel.svelte -->
<!-- Sprint 115 — command-palette.ts (548 satır) → Svelte 5 Runes (ADR-0008 Faz 2) -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.js';
  import {
    fetchMyPermissions,
    hasPerm,
    PERM_MANAGE_CHANNELS,
    PERM_MANAGE_ROLES,
    PERM_MANAGE_SERVER,
  } from './permissions/myPermissions.js';

  const log = createLogger('CommandPalettePanel');

  interface Command {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    category?: string;
    shortcut?: string;
    action: () => unknown;
    keywords?: string[];
    hidden?: boolean;
    available?: () => boolean;
  }

  interface ServerSummary { _id: string; name?: string; [key: string]: unknown }
  interface ChannelSummary { _id: string; name?: string; type?: string; [key: string]: unknown }
  interface PersonSummary {
    _id?: string; id?: string; username?: string; displayName?: string;
    nickname?: string; avatarColor?: string; [key: string]: unknown;
  }
  interface DmConversation { _id?: string; other?: PersonSummary; [key: string]: unknown }
  interface GroupSummary { _id: string; name?: string; [key: string]: unknown }

  // ── State ──────────────────────────────────────────────────────────────────
  let isVisible    = $state(false);
  let query        = $state('');
  let selectedIdx  = $state(0);
  let commands     = $state<Command[]>([]);
  let inputEl = $state<HTMLInputElement | undefined>();
  let panelEl = $state<HTMLDivElement | undefined>();
  let returnFocusEl: HTMLElement | null = null;
  let openSequence = 0;

  // ── Derived ────────────────────────────────────────────────────────────────
  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const visible = commands.filter(c => !c.hidden && isCommandAvailable(c));
    if (!q) return visible.slice(0, 12);
    return visible.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.keywords?.some(k => k.toLowerCase().includes(q))
    ).slice(0, 12);
  });

  let selectedCommand = $derived.by(() => filtered[Math.min(selectedIdx, filtered.length - 1)] ?? null);

  // ── Reset selection when query changes ────────────────────────────────────
  // Faz 8.1: `isVisible` de izlenir. Önceden yalnızca `query` izleniyordu;
  // palet zaten boş sorguyla kapandığı için tekrar açılışta effect yeniden
  // çalışmıyor ve arama kutusu ODAKLANMIYORDU (tarayıcıda doğrulandı:
  // document.activeElement panel dışında kalıyor, yazılan harfler kutuya
  // gitmiyordu).
  $effect(() => {
    query;      // track
    isVisible;  // track
    selectedIdx = 0;
    queueMicrotask(() => { if (isVisible) inputEl?.focus(); });
  });

  function readList<T>(name: string): T[] {
    if (!BridgeRegistry.has(name)) return [];
    try {
      const value = BridgeRegistry.call<unknown>(name);
      return Array.isArray(value) ? value as T[] : [];
    } catch (error) {
      log.warn(`Komut kaynağı okunamadı: ${name}`, error);
      return [];
    }
  }

  function recordOf(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  }

  function stringField(value: unknown, key: string): string {
    const field = recordOf(value)?.[key];
    return typeof field === 'string' && field.trim() ? field : '';
  }

  function entityId(value: unknown): string {
    return stringField(value, '_id') || stringField(value, 'id');
  }

  function personName(value: unknown): string {
    return stringField(value, 'nickname')
      || stringField(value, 'displayName')
      || stringField(value, 'username')
      || entityId(value)
      || t('ui_bridge_user', 'Bridge kullanıcısı');
  }

  function commandKey(value: string): string {
    return encodeURIComponent(value).replace(/%/g, '-');
  }

  function currentUserId(): string {
    try {
      const user = BridgeRegistry.has('getMe')
        ? BridgeRegistry.call<PersonSummary | null>('getMe')
        : BridgeRegistry.has('me') ? BridgeRegistry.call<PersonSummary | null>('me') : null;
      return entityId(user);
    } catch (error) {
      log.warn('Komut paleti kullanıcı kapsamını okuyamadı', error);
      return '';
    }
  }

  function currentUserIsSiteAdmin(): boolean {
    try {
      const user = BridgeRegistry.has('getMe')
        ? BridgeRegistry.call<Record<string, unknown> | null>('getMe')
        : BridgeRegistry.has('me') ? BridgeRegistry.call<Record<string, unknown> | null>('me') : null;
      return user?.isAdmin === true;
    } catch (error) {
      log.warn('Komut paleti global admin durumunu okuyamadı', error);
      return false;
    }
  }

  function isCommandAvailable(command: Command): boolean {
    if (!command.available) return true;
    try { return Boolean(command.available()); }
    catch (error) {
      log.warn(`Komut uygunluğu okunamadı: ${command.id}`, error);
      return false;
    }
  }

  function sanitizeCommands(values: unknown[]): Command[] {
    const result: Command[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const raw = recordOf(value);
      if (!raw) continue;
      const id = stringField(raw, 'id');
      const label = stringField(raw, 'label');
      const action = raw?.action;
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
        || !label || typeof action !== 'function' || seen.has(id)) continue;
      if (raw.available !== undefined && typeof raw.available !== 'function') continue;
      seen.add(id);
      result.push({
        id,
        label,
        action: action as () => unknown,
        description: stringField(raw, 'description') || undefined,
        icon: stringField(raw, 'icon') || undefined,
        category: stringField(raw, 'category') || undefined,
        shortcut: stringField(raw, 'shortcut') || undefined,
        keywords: Array.isArray(raw.keywords)
          ? raw.keywords.filter((keyword): keyword is string => typeof keyword === 'string' && Boolean(keyword.trim()))
          : undefined,
        hidden: typeof raw.hidden === 'boolean' ? raw.hidden : undefined,
        available: typeof raw.available === 'function' ? raw.available as () => boolean : undefined,
      });
    }
    return result;
  }

  function voiceReady(action: string): boolean {
    return BridgeRegistry.has(action)
      && BridgeRegistry.has('voicePanel:getControlState')
      && Boolean(BridgeRegistry.call<{ inVoice?: boolean }>('voicePanel:getControlState')?.inVoice);
  }

  /**
   * Palet bir eylem sahibi değildir. Her açılışta kanonik sahiplerin mevcut
   * salt-okunur görünümlerinden komut üretir ve çalıştırmayı yine o sahiplere
   * delege eder. Böylece kapanmış/uykuda bir özellik için ölü komut oluşmaz.
   */
  function buildCommands(permissionBits: number | null): Command[] {
    const navigation: Command[] = [];
    const people: Command[] = [];
    const serverActions: Command[] = [];
    const voice: Command[] = [];
    const app: Command[] = [];

    if (BridgeRegistry.has('showFriendsPanel')) {
      navigation.push({
        id: 'open-friends', label: t("ui_arkadaslari_ac", "Arkadaşları Aç"), category: 'Navigasyon', icon: 'people',
        description: t("dm_friends_requests", "Arkadaşlar ve istekler"), keywords: ['friends', 'arkadaş', 'istek'],
        action: () => BridgeRegistry.call('showFriendsPanel'),
      });
    }
    if (BridgeRegistry.has('showInbox')) {
      navigation.push({
        id: 'open-inbox', label: t("ui_gelen_kutusunu_ac", "Gelen Kutusunu Aç"), category: 'Navigasyon', icon: 'inbox',
        description: t("ui_okunmamislar_ve_bahsetmeler", "Okunmamışlar ve bahsetmeler"), keywords: ['inbox', 'gelen kutusu', 'mention', 'bahsetme'],
        action: () => BridgeRegistry.call('showInbox'),
      });
    }
    if (BridgeRegistry.has('showSaved')) {
      navigation.push({
        id: 'open-saved', label: t("ui_kaydedilenler_takip", "Kaydedilenler / Takip"), category: 'Navigasyon', icon: 'saved',
        description: t("ui_sonrasi_icin_kaydedilen_mesajlar", "Sonrası için kaydedilen mesajlar"), keywords: ['saved', 'follow-up', 'takip', 'kaydet'],
        action: () => BridgeRegistry.call('showSaved'),
      });
    }
    if (BridgeRegistry.has('showDmPanel')) {
      navigation.push({
        id: 'open-dm-panel', label: t("ui_direkt_mesajlari_ac", "Direkt Mesajları Aç"), category: 'Navigasyon', icon: 'message',
        keywords: ['dm', 'direct message', 'direkt mesaj'], action: () => BridgeRegistry.call('showDmPanel'),
      });
    }
    if (BridgeRegistry.has('showGroupDmPanel')) {
      navigation.push({
        id: 'open-gdm-panel', label: t("ui_grup_dmleri_ac", "Grup DM’leri Aç"), category: 'Navigasyon', icon: 'people',
        keywords: ['gdm', 'group dm', 'grup mesaj'], action: () => BridgeRegistry.call('showGroupDmPanel'),
      });
    }

    if (BridgeRegistry.has('navigateToChannel')) {
      for (const channel of readList<ChannelSummary>('getCurrentServerChannels')) {
        const id = stringField(channel, '_id');
        if (!id) continue;
        const name = stringField(channel, 'name') || id;
        const type = stringField(channel, 'type');
        navigation.push({
          id: `channel-${commandKey(id)}`,
          label: t('palette_go_to_channel', 'Kanala Git: {name}', { name }),
          description: type === 'voice' ? t("ui_ses_kanali", "Ses kanalı") : t("ui_sunucu_kanali", "Sunucu kanalı"),
          category: 'Navigasyon', icon: type === 'voice' ? 'headphones' : 'channel',
          keywords: ['channel', 'kanal', name],
          action: () => BridgeRegistry.call('navigateToChannel', id),
        });
      }
    }

    if (BridgeRegistry.has('selectServer')) {
      for (const server of readList<ServerSummary>('getAvailableServers')) {
        const rawServer = recordOf(server);
        const id = stringField(rawServer, '_id');
        if (!rawServer || !id) continue;
        const name = stringField(rawServer, 'name') || id;
        const safeServer = { ...rawServer, _id: id, name } as ServerSummary;
        navigation.push({
          id: `server-${commandKey(id)}`,
          label: t('palette_go_to_server', 'Sunucuya Git: {name}', { name }),
          category: 'Navigasyon', icon: 'server', keywords: ['server', 'sunucu', name],
          action: () => BridgeRegistry.call('selectServer', safeServer),
        });
      }
    }

    if (BridgeRegistry.has('openDm')) {
      const seen = new Set<string>();
      for (const conversation of readList<DmConversation>('getDmConversations')) {
        const person = recordOf(conversation)?.other;
        const id = person ? entityId(person) : '';
        if (!person || !id || seen.has(id)) continue;
        seen.add(id);
        const name = personName(person);
        navigation.push({
          id: `dm-${commandKey(id)}`, label: t('cp_open_dm_named', 'DM Aç: {name}', { name }), category: 'Navigasyon', icon: 'message',
          keywords: ['dm', 'direct message', 'direkt mesaj', name, stringField(person, 'username')],
          action: () => BridgeRegistry.call('openDm', id, name, stringField(person, 'avatarColor') || undefined),
        });
      }
    }

    if (BridgeRegistry.has('groupDmPanel:openGroupDm')) {
      for (const group of readList<GroupSummary>('groupDmPanel:getGroups')) {
        const rawGroup = recordOf(group);
        const id = stringField(rawGroup, '_id');
        if (!rawGroup || !id) continue;
        const name = stringField(rawGroup, 'name') || id;
        const safeGroup = { ...rawGroup, _id: id, name } as GroupSummary;
        navigation.push({
          id: `gdm-${commandKey(id)}`, label: t('cp_open_group_dm_named', 'Grup DM Aç: {name}', { name }),
          category: 'Navigasyon', icon: 'people', keywords: ['gdm', 'group dm', 'grup', name],
          action: () => BridgeRegistry.call('groupDmPanel:openGroupDm', safeGroup),
        });
      }
    }

    const meId = currentUserId();
    for (const member of readList<PersonSummary>('getCurrentServerMembers')) {
      const id = entityId(member);
      if (!id) continue;
      const name = personName(member);
      if (id !== meId && BridgeRegistry.has('openDm')) {
        people.push({
          id: `message-user-${commandKey(id)}`, label: t('cp_send_message_named', 'Mesaj Gönder: {name}', { name }),
          category: t('cp_category_people', 'Kişiler'), icon: 'message', keywords: ['message user', 'mesaj gönder', name, stringField(member, 'username')],
          action: () => BridgeRegistry.call('openDm', id, name, stringField(member, 'avatarColor') || undefined),
        });
      }
      if (BridgeRegistry.has('openMemberProfile')) {
        people.push({
          id: `profile-user-${commandKey(id)}`, label: t('cp_view_profile_named', 'Profili Görüntüle: {name}', { name }),
          category: t('cp_category_people', 'Kişiler'), icon: 'people', keywords: ['view profile', 'profil', 'kişi', name, member.username ?? ''],
          action: () => BridgeRegistry.call('openMemberProfile', id),
        });
      }
    }

    const sid = currentServerId();
    if (sid && BridgeRegistry.has('openInvitePanel')) {
      serverActions.push({
        id: 'invite-people', label: t("ui_kisileri_davet_et", "Kişileri Davet Et"), category: t('cp_category_server', 'Sunucu'), icon: 'invite',
        keywords: ['invite people', 'davet', 'invite'], action: () => BridgeRegistry.call('openInvitePanel'),
      });
    }
    if (sid && permissionBits !== null && hasPerm(permissionBits, PERM_MANAGE_CHANNELS)
      && BridgeRegistry.has('openCreateChannel')) {
      serverActions.push({
        id: 'create-channel', label: t("ui_kanal_olustur", "Kanal Oluştur"), category: t('cp_category_server', 'Sunucu'), icon: 'channel',
        keywords: ['create channel', 'kanal oluştur', 'new channel'], action: () => BridgeRegistry.call('openCreateChannel'),
      });
    }
    if (sid && permissionBits !== null
      && (hasPerm(permissionBits, PERM_MANAGE_SERVER) || hasPerm(permissionBits, PERM_MANAGE_ROLES))
      && BridgeRegistry.has('openServerSettings')) {
      const initialTab = hasPerm(permissionBits, PERM_MANAGE_SERVER) ? 'general' : 'roles';
      serverActions.push({
        id: 'server-settings', label: t("ui_sunucu_ayarlari", "Sunucu Ayarları"), category: t('cp_category_server', 'Sunucu'), icon: 'settings',
        keywords: ['server settings', 'sunucu ayarları', 'roles', 'roller'],
        action: () => BridgeRegistry.call('openServerSettings', initialTab),
      });
    }
    if (sid && permissionBits !== null && hasPerm(permissionBits, PERM_MANAGE_SERVER)
      && BridgeRegistry.has('openServerSettings')) {
      serverActions.push({
        id: 'server-health', label: 'Sistem Durumu', category: t('cp_category_server', 'Sunucu'), icon: 'diagnostics',
        description: t("ui_veritabani_yuklemeler_realtime_ve_voice_servis_durum", "Veritabanı, yüklemeler, realtime ve voice servis durumunu aç"),
        keywords: ['health', 'status', 'sistem', 'durum', 'operator', 'servis'],
        action: () => BridgeRegistry.call('openServerSettings', 'health'),
      });
    }
    if (sid && permissionBits !== null && hasPerm(permissionBits, PERM_MANAGE_CHANNELS)
      && BridgeRegistry.has('openCurrentChannelPermissions')) {
      serverActions.push({
        id: 'channel-permissions', label: t("ui_bu_kanalin_izinlerini_ac", "Bu Kanalın İzinlerini Aç"), category: t('cp_category_server', 'Sunucu'), icon: 'shield',
        description: t("ui_etkin_izinleri_acikla_ve_rol_olarak_onizle", "Etkin izinleri açıkla ve rol olarak önizle"),
        keywords: ['permissions', 'izin', 'kanal izni', 'effective permissions'],
        action: () => BridgeRegistry.call('openCurrentChannelPermissions'),
      });
    }

    voice.push(
      {
        id: 'mute-toggle', label: t("ui_mikrofonu_ac_kapat", "Mikrofonu Aç/Kapat"), category: t('cp_category_voice', 'Ses'), icon: 'microphone',
        shortcut: 'Ctrl+Shift+M', keywords: ['mute', 'mikrofon', 'ses', 'audio'],
        action: () => BridgeRegistry.call('voicePanel:toggleMute'),
        available: () => voiceReady('voicePanel:toggleMute'),
      },
      {
        id: 'deafen-toggle', label: t("ui_hoparloru_ac_kapat", "Hoparlörü Aç/Kapat"), category: t('cp_category_voice', 'Ses'), icon: 'headphones',
        shortcut: 'Ctrl+Shift+D', keywords: ['deafen', 'hoparlör', 'kulaklık', 'speaker'],
        action: () => BridgeRegistry.call('voicePanel:toggleDeafen'),
        available: () => voiceReady('voicePanel:toggleDeafen'),
      },
      {
        id: 'leave-voice', label: t("ui_ses_kanalindan_ayril", "Ses Kanalından Ayrıl"), category: t('cp_category_voice', 'Ses'), icon: 'hangup',
        keywords: ['leave voice', 'sesten ayrıl', 'hang up'],
        action: () => BridgeRegistry.call('voicePanel:leaveVoice'),
        available: () => voiceReady('voicePanel:leaveVoice'),
      },
    );
    if (BridgeRegistry.has('openVoiceCheck')) {
      voice.push({
        id: 'voice-check', label: 'Voice Check', category: t('cp_category_voice', 'Ses'), icon: 'diagnostics',
        description: t("ui_mikrofon_cihaz_ve_baglanti_tanilamasi", "Mikrofon, cihaz ve bağlantı tanılaması"),
        keywords: ['voice check', 'diagnostics', 'tanılama', 'mikrofon testi', 'ses testi'],
        action: () => BridgeRegistry.call('openVoiceCheck'),
      });
    }

    app.push(
      {
        // ── TANITIM TURUNU YENIDEN ACMA ─────────────────────────────────
        // KAPATILAN GERCEK BOSLUK: `showOnboardingWizard` kayitliydi ama
        // istemcinin TAMAMINDA tek bir cagiran yoktu. Tur bir kez
        // kapatildiktan sonra kullanicinin onu geri getirmesinin HICBIR yolu
        // yoktu — ogretici bir yuzey icin bu, ozelligin yok olmasi demektir.
        //
        // Palet dogru yer: klavyeden bulunabilir, yeni bir arayuz yuzeyi
        // eklemez ve `available()` sayesinde kayit yoksa hic gorunmez.
        id: 'show-onboarding', label: t("ui_tanitim_turunu_goster", "Tanıtım Turunu Göster"),
        description: t("ui_bridgei_ilk_kez_kullananlar_icin_kisa_tur", "Bridge’i ilk kez kullananlar için kısa tur"),
        icon: 'help', category: 'Uygulama',
        keywords: ['onboarding', 'tur', 'tanitim', 'tanıtım', 'yardim', 'yardım', 'help', 'tour'],
        action: () => BridgeRegistry.call('showOnboardingWizard'),
        available: () => BridgeRegistry.has('showOnboardingWizard'),
      },
      {
        // FAZ K/1 — KURESEL ARAMA. Dort kaynagi da kapsar (kanal, DM, grup DM,
        // konu yanitlari); sunucu secili olmasa da calisir.
        id: 'open-global-search', label: t("ui_tum_mesajlarda_ara", "Tüm Mesajlarda Ara"),
        description: t("ui_kanallar_dmler_grup_mesajlari_ve_konu_yanitlari", "Kanallar, DM’ler, grup mesajları ve konu yanıtları"),
        icon: 'search', category: 'Uygulama', shortcut: 'Ctrl+F',
        keywords: ['search', 'ara', 'bul', 'find', 'global', 'dm', 'mesaj'],
        action: () => BridgeRegistry.call('openGlobalSearch'),
        available: () => BridgeRegistry.has('openGlobalSearch'),
      },
      {
        // FAZ K/1 — `Ctrl+F` ETIKETI KALDIRILDI. Bu kisayol HICBIR ZAMAN
        // baglanmamisti (tum istemcide tek gectigi yer bu etiketti): palet
        // kullaniciya calismayan bir kisayol OGRETIYORDU. Ctrl+F artik
        // kuresel aramaya baglidir; sunucu ici arama kisayolsuz kalir.
        id: 'open-search', label: t("ui_sunucuda_ara", "Sunucuda Ara"),
        description: t("ui_bu_sunucunun_kanal_uye_ve_kanal_adlarinda_ara", "Bu sunucunun kanal, üye ve kanal adlarında ara"),
        icon: 'search', category: 'Uygulama', keywords: ['search', 'ara', 'sunucu', 'üye', 'kanal'],
        action: () => { const currentSid = currentServerId(); if (currentSid) BridgeRegistry.call('openSearch', currentSid); },
        available: () => BridgeRegistry.has('openSearch') && Boolean(currentServerId()),
      },
      {
        id: 'open-polls', label: t("ui_kanal_anketleri", "Kanal Anketleri"),
        description: t("ui_bu_kanaldaki_anketleri_goruntule_olustur_ve_oy_ver", "Bu kanaldaki anketleri görüntüle, oluştur ve oy ver"),
        icon: 'poll', category: 'Uygulama', keywords: ['poll', 'anket', 'vote', 'oy'],
        action: () => BridgeRegistry.call('openPolls'),
        available: () => BridgeRegistry.has('openPolls') && Boolean(BridgeRegistry.call<{ _id?: string } | null>('getCurrentChannel')?._id),
      },
      {
        // FAZ K/5 — bildirim tercihleri artik GERCEK bir panel; acilis yolu da olmali.
        id: 'open-notification-prefs', label: t("ui_bildirim_ayarlari", "Bildirim Ayarları"),
        description: t("ui_sunucu_ve_kanal_bazli_bildirim_duzeyi_sessize_alma", "Sunucu ve kanal bazlı bildirim düzeyi, sessize alma"),
        icon: 'inbox', category: 'Uygulama',
        keywords: ['bildirim', 'notification', 'sessiz', 'mute', 'snooze', 'erteleme'],
        action: () => BridgeRegistry.call('openNotificationPrefs'),
        available: () => BridgeRegistry.has('openNotificationPrefs') && Boolean(currentServerId()),
      },
      {
        id: 'open-plugin-marketplace', label: t("ui_bot_ve_eklenti_pazari", "Bot ve Eklenti Pazarı"),
        description: t("ui_botlari_ve_eklentileri_kesfet", "Botları ve eklentileri keşfet"), icon: 'plugin', category: 'Uygulama',
        keywords: ['plugin', 'bot', 'marketplace', 'eklenti'],
        action: () => BridgeRegistry.call('openMarketplacePage'),
        available: () => BridgeRegistry.has('openMarketplacePage'),
      },
      {
        id: 'open-admin', label: t("ui_moderasyon_yonetim", "Moderasyon / Yönetim"),
        description: t("ui_yonetim_ve_moderasyon_araclarini_ac", "Yönetim ve moderasyon araçlarını aç"), icon: 'shield', category: t('cp_category_server', 'Sunucu'),
        keywords: ['moderation', 'admin', 'mod', 'yönetim', 'moderasyon'],
        action: () => BridgeRegistry.call('openAdminDashboard'),
        available: () => BridgeRegistry.has('openAdminDashboard') && currentUserIsSiteAdmin(),
      },
      {
        id: 'open-settings', label: t("ui_ayarlari_ac", "Ayarları Aç"), description: t("ui_kullanici_ayarlari_panelini_ac", "Kullanıcı ayarları panelini aç"),
        icon: 'settings', category: 'Uygulama', shortcut: 'Ctrl+,',
        keywords: ['settings', 'preferences', 'ayar', 'tercih', 'profil'],
        action: () => BridgeRegistry.call('openSettingsModal'),
        available: () => BridgeRegistry.has('openSettingsModal'),
      },
      {
        id: 'theme-toggle', label: t("tip_theme", "Temayı Değiştir"), description: t("ui_uygulama_temasini_degistir", "Uygulama temasını değiştir"),
        icon: 'theme', category: 'Uygulama', shortcut: 'Ctrl+Shift+T',
        keywords: ['switch theme', 'theme', 'dark', 'light', 'karanlık', 'aydınlık', 'tema'],
        action: () => BridgeRegistry.call('cycleTheme'),
        available: () => BridgeRegistry.has('cycleTheme'),
      },
    );

    const extras = BridgeRegistry.get<unknown>('extraCommands');
    return sanitizeCommands([...navigation, ...people, ...serverActions, ...voice, ...app,
      ...(Array.isArray(extras) ? extras : [])]);
  }


  /**
   * FAZ F — AKTIF SUNUCU KIMLIGI: KANONIK KAYNAK.
   *
   * Onceki kod `BridgeRegistry.get('currentServerId')` okuyordu. Bu ad
   * HICBIR YERDE KAYITLI DEGIL (olcum: 0 register cagrisi), dolayisiyla her
   * zaman `undefined` donuyordu. Sonuc: "Aramayi Ac" ve "Sunucu ID'sini
   * Kopyala" komutlarinin `available()` denetimi HER ZAMAN false — komutlar
   * palette hic gorunmuyordu. SearchPanel'in uykuda olmasindan BAGIMSIZ,
   * ikinci ve ayri bir kusurdu.
   *
   * Kanonik sahip `AppState.svelte`: `register('currentServer', () => ...)`.
   * Bir GETTER kayitlidir; bu yuzden `get()` (fonksiyonun kendisini dondurur)
   * degil `call()` kullanilir.
   */
  function currentServerId(): string | undefined {
    if (!BridgeRegistry.has('currentServer')) return undefined;
    try {
      const server = BridgeRegistry.call<{ _id?: string } | null>('currentServer');
      return stringField(server, '_id') || undefined;
    } catch (error) {
      log.warn('Komut paleti sunucu kapsamını okuyamadı', error);
      return undefined;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function open() {
    closeExclusivePeers('command');
    const seq = ++openSequence;
    const active = document.activeElement;
    returnFocusEl = active instanceof HTMLElement ? active : null;
    // Yetki gerektirmeyen gerçek eylemler anında hazırdır; paletin açılışı ağ
    // isteğini beklemez. Yönetim komutları sunucu sinyali gelene kadar yoktur.
    commands = buildCommands(null);
    isVisible = true;
    query = '';
    selectedIdx = 0;

    const sid = currentServerId();
    if (sid) {
      void fetchMyPermissions(encodeURIComponent(sid)).then(permissionBits => {
        // Kapanmış/yeniden açılmış palete veya başka sunucuya geç gelen yanıt
        // komut listesini yazamaz.
        if (!isVisible || seq !== openSequence || currentServerId() !== sid) return;
        commands = buildCommands(permissionBits);
      });
    }
  }

  function close(restoreFocus: boolean | Event = true) {
    const shouldRestoreFocus = typeof restoreFocus === 'boolean' ? restoreFocus : true;
    openSequence += 1; // uçuşta olan yetki görünürlüğünü geçersiz kıl
    isVisible = false;
    query = '';
    const target = returnFocusEl;
    returnFocusEl = null;
    if (!shouldRestoreFocus) return;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  }

  function execute(cmd: Command) {
    // Komut yeni bir yüzey açıyorsa paletin eski tetikleyiciye odak iadesi o
    // yüzeyin odağını çalmamalı. Escape/manuel kapanışta ise iade korunur.
    close(false);
    try {
      const result = cmd.action();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(err => log.error('Command failed', { id: cmd.id, err }));
      }
    } catch (err) {
      log.error('Command failed', { id: cmd.id, err });
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isVisible) return;

    // FAZ E — TAB DALI KALDIRILDI; kanonik `use:focusTrap` sahiplenir.
    //
    // Bu bileşen çalışan ama ÜÇÜNCÜ bir tuzak kopyasıydı (diğerleri:
    // SettingsModal ve VoicePanel). Action ile BİRLİKTE bırakılamazdı: her
    // ikisi de Tab'da preventDefault() + focus() çağırdığı için odak tek
    // Tab'da İKİ adım atlardı.
    //
    // Ok tuşları/Enter/Escape burada KALIR — bunlar palet semantiğidir,
    // odak kapsama değil.

    switch (e.key) {
      case 'Escape':
        e.preventDefault(); close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedCommand) execute(selectedCommand!);
        break;
    }
  }

  function onGlobalKeyDown(e: KeyboardEvent) {
    // Ctrl/Cmd + K → aç
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      isVisible ? close() : open();
      return;
    }

    if (!isVisible) return;

    // Faz 8.1: palet modal'dır — Escape/oklar odak panelin İÇİNDE olmasa da
    // çalışmalı. (Tarayıcı doğrulaması: autofocus kaçtığında Escape hiç
    // ulaşmıyor, panel kapanmıyordu.) Panel içinden gelen olaylar aşağıdaki
    // `onKeyDown` tarafından zaten işlendiği için burada atlanır — aksi halde
    // Enter komutu İKİ KEZ çalıştırırdı.
    // `e.target` her zaman Node değildir (window'a düşen olaylarda window'dur);
    // contains()'e Node olmayan değer geçmek TypeError fırlatır ve dinleyiciyi
    // sessizce yarıda keserdi.
    const target = e.target;
    if (target instanceof Node && panelEl?.contains(target)) return;

    onKeyDown(e);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function onContextChange(): void {
    openSequence += 1;
    commands = [];
    if (isVisible) close(false);
  }

  onMount(() => {
    BridgeRegistry.register('openCommandPalette', open);
    BridgeRegistry.register('closeCommandPalette', close);
    document.addEventListener('bridge:load-channels', onContextChange);
    document.addEventListener('bridge:auth-success', onContextChange);
    document.addEventListener('bridge:auth-logout', onContextChange);
  });

  // Faz 8.1: kayıtlar unmount'ta bırakılmalı — aksi halde yok edilmiş bileşene
  // ait kapanışlar registry'de kalır (klavye dinleyicisini <svelte:window>
  // zaten otomatik temizliyor).
  onDestroy(() => {
    openSequence += 1;
    BridgeRegistry.unregister('openCommandPalette');
    BridgeRegistry.unregister('closeCommandPalette');
    document.removeEventListener('bridge:load-channels', onContextChange);
    document.removeEventListener('bridge:auth-success', onContextChange);
    document.removeEventListener('bridge:auth-logout', onContextChange);
    if (returnFocusEl?.isConnected) returnFocusEl.focus();
    returnFocusEl = null;
  });

  // Category groups
  let groupedFiltered = $derived.by(() => {
    const items = filtered;
    const groups: Record<string, Command[]> = {};
    for (const cmd of items) {
      const cat = cmd.category ?? t('report_reason_other', 'Diğer');
      (groups[cat] ??= []).push(cmd);
    }
    return groups;
  });

  let flatFiltered = $derived.by(() => filtered);
</script>

<svelte:window onkeydown={onGlobalKeyDown} />

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="cp-overlay" role="presentation" onclick={() => close()}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="cp-panel"
    bind:this={panelEl}
    role="dialog"
    aria-label={t('onb_s6_title')}
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    use:focusTrap={{ active: isVisible, initialFocus: ".cp-input" }}
    onkeydown={onKeyDown}
  >
    <div class="cp-header">
      <span class="cp-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 7.5 12 3l7 4.5v9L12 21l-7-4.5z"/><path d="m9 15 6-6M9 9h.01M15 15h.01"/></svg>
      </span>
      <input
        class="cp-input"
        bind:this={inputEl}
        type="text"
        bind:value={query}
        placeholder={t('cmd_search_ph', 'Komut ara… (Ctrl+K ile aç/kapat)')}
        aria-label={t('attr_komut_ara_9b9f230', "Komut ara")}
        aria-autocomplete="list"
        aria-controls="cp-listbox"
        aria-activedescendant={selectedCommand ? `cp-item-${selectedCommand!.id}` : undefined}
        autocomplete="off"
      />
      <button type="button" class="cp-esc" onclick={close}>ESC</button>
    </div>

    <ul id="cp-listbox" class="cp-list" role="listbox" aria-label={t("cp_commands_aria", "Komutlar")}>
      {#if flatFiltered.length === 0}
        <li class="cp-empty" role="option" aria-selected="false">
          {t("ui_no_command_for_query", undefined, { query })}
        </li>
      {:else}
        {#each Object.entries(groupedFiltered) as [category, cmds]}
          <li class="cp-category" role="presentation">{category}</li>
          {#each cmds as cmd}
            {@const idx = flatFiltered.findIndex(c => c.id === cmd.id)}
            {@const isSelected = idx === selectedIdx}
            <!-- Klavyeyle açılışta hareketsiz imleç, altında beliren satırı
                 seçemez. Fare seçimi yalnız gerçek hareketle devralır. -->
            <li
              id="cp-item-{cmd.id}"
              class="cp-item {isSelected ? 'selected' : ''}"
              role="option"
              aria-selected={isSelected}
              tabindex={isSelected ? 0 : -1}
              onclick={() => execute(cmd)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); execute(cmd); } }}
              onmousemove={() => { selectedIdx = idx; }}
            >
              {#if cmd.icon}
                <span class="cp-item-icon icon-{cmd.icon}" aria-hidden="true">
                  {#if cmd.icon === 'theme'}
                    <svg viewBox="0 0 24 24"><path d="M19 15.2A8 8 0 0 1 8.8 5a7.5 7.5 0 1 0 10.2 10.2Z"/></svg>
                  {:else if cmd.icon === 'read'}
                    <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/><path d="M19 12v6H5V6h9"/></svg>
                  {:else if cmd.icon === 'search'}
                    <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/></svg>
                  {:else if cmd.icon === 'settings'}
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></svg>
                  {:else if cmd.icon === 'people'}
                    <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 5.5a3 3 0 0 1 0 5.8M16.5 14a5 5 0 0 1 4 5"/></svg>
                  {:else if cmd.icon === 'inbox'}
                    <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 14h4l2 2h4l2-2h4"/></svg>
                  {:else if cmd.icon === 'saved'}
                    <svg viewBox="0 0 24 24"><path d="M7 4h10v16l-5-3-5 3z"/></svg>
                  {:else if cmd.icon === 'message'}
                    <svg viewBox="0 0 24 24"><path d="M4 5h16v12H9l-5 4z"/></svg>
                  {:else if cmd.icon === 'channel'}
                    <svg viewBox="0 0 24 24"><path d="M9 3 7 21M17 3l-2 18M4 9h16M3 15h16"/></svg>
                  {:else if cmd.icon === 'server'}
                    <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/></svg>
                  {:else if cmd.icon === 'invite'}
                    <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M18 8v6M15 11h6"/></svg>
                  {:else if cmd.icon === 'hangup'}
                    <svg viewBox="0 0 24 24"><path d="M5 17c4.5-4 9.5-4 14 0M7 15l-2-3M17 15l2-3"/></svg>
                   {:else if cmd.icon === 'microphone'}
                     <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>
                  {:else if cmd.icon === 'diagnostics'}
                    <svg viewBox="0 0 24 24"><path d="M3 12h4l2-6 4 12 2-6h6"/><path d="M5 20h14"/></svg>
                  {:else if cmd.icon === 'headphones'}
                    <svg viewBox="0 0 24 24"><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v7H5a1 1 0 0 1-1-1zm16 0h-3v7h2a1 1 0 0 0 1-1z"/></svg>
                  {:else if cmd.icon === 'copy'}
                    <svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  {:else if cmd.icon === 'bug'}
                    <svg viewBox="0 0 24 24"><path d="M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM9 5 7 3m8 2 2-2M4 10h4m8 0h4M4 16h4m8 0h4"/><path d="M12 9v10"/></svg>
                  {:else if cmd.icon === 'keyboard'}
                    <svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/></svg>
                  {:else if cmd.icon.startsWith('status-')}
                    <span class="cp-status-dot"></span>
                  {:else}
                    <span class="cp-fallback-icon">{cmd.icon.slice(0, 2)}</span>
                  {/if}
                </span>
              {/if}
              <span class="cp-item-text">
                <span class="cp-item-label">{cmd.label}</span>
                {#if cmd.description}
                  <span class="cp-item-desc">{cmd.description}</span>
                {/if}
              </span>
              {#if cmd.shortcut}
                <kbd class="cp-item-shortcut">{cmd.shortcut}</kbd>
              {/if}
            </li>
          {/each}
        {/each}
      {/if}
    </ul>

    <div class="cp-footer" aria-hidden="true">
      <span><kbd>↑↓</kbd> {t('markup_gezin_8189458', "Gezin")}</span>
      <span><kbd>↵</kbd> {t('cmd_run', 'Çalıştır')}</span>
      <span><kbd>ESC</kbd> {t('close')}</span>
    </div>
  </div>
</div>
{/if}

<style>
.cp-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--layer-modal);
  display: flex;
  justify-content: center;
  padding: clamp(24px, 8dvh, 72px) 16px max(16px, env(safe-area-inset-bottom));
  /* Faz E — overlay backdrop'ları TEK aile: ChannelPermsEditor, StickerPanel,
     GroupDmPanel ve EmptyServerStart ile aynı ifade. */
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(8px) saturate(110%);
  animation: cp-overlay-in var(--duration-fast) var(--ease-out);
}

.cp-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(540px, calc(var(--bridge-visual-viewport-height, 100dvh) - 96px));
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-xl);
  animation: cp-panel-in var(--duration-base) var(--ease-spring);
}

.cp-panel::before {
  position: absolute;
  inset: 0 0 auto;
  z-index: 1;
  height: 2px;
  content: '';
  background: linear-gradient(90deg, var(--brand), var(--accent), transparent 88%);
}

.cp-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 56px;
  padding: 10px 14px;
  background: var(--bg-3);
  border-bottom: 1px solid var(--border);
}

.cp-icon {
  flex: 0 0 auto;
  color: var(--brand);
  font-size: var(--text-lg);
  line-height: 1;
}

.cp-icon svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.cp-input {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  font: 600 var(--text-base)/1.4 var(--font-sans);
  background: transparent;
  border: 0;
  outline: 0;
}

.cp-input::placeholder { color: var(--text-muted); }

.cp-esc {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: var(--text-secondary);
  font: 700 var(--text-2xs)/1.4 var(--font-mono);
  cursor: pointer;
  background: var(--bg-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-chip);
}

.cp-esc:hover { color: var(--text-primary); background: var(--bg-hover); }

.cp-esc:focus-visible,
.cp-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }

.cp-list {
  flex: 1;
  padding: 6px;
  margin: 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-gutter: stable;
}

.cp-category {
  padding: 9px 10px 4px;
  color: var(--text-muted);
  font: 700 var(--text-2xs)/1.2 var(--font-sans);
  letter-spacing: .09em;
  text-transform: uppercase;
}

.cp-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  padding: 7px 10px;
  color: var(--text-primary);
  cursor: pointer;
  border-radius: var(--radius-control);
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}

.cp-item.selected, .cp-item:hover {
  background: var(--brand-bg);
}

.cp-item.selected::before {
  position: absolute;
  inset: 9px auto 9px 0;
  width: 2px;
  content: '';
  background: var(--brand);
  border-radius: var(--radius-pill);
}

.cp-item-icon {
  display: grid;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  color: var(--text-secondary);
  place-items: center;
}

.cp-item-icon svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.cp-item.selected .cp-item-icon { color: var(--brand); }
.cp-status-dot { width: 9px; height: 9px; background: var(--status-online); border: 2px solid var(--bg-2); border-radius: 50%; box-shadow: 0 0 0 1px var(--border-strong); }
.icon-status-idle .cp-status-dot { background: var(--status-idle); }
.icon-status-dnd .cp-status-dot { background: var(--status-dnd); }
.cp-fallback-icon { font-size: var(--text-xs); font-weight: 750; }

.cp-item-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
}

.cp-item-label {
  overflow: hidden;
  color: inherit;
  font-size: var(--text-sm);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-item-desc {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-item-shortcut {
  flex: 0 0 auto;
  padding: 2px 6px;
  color: var(--text-secondary);
  font: 650 var(--text-2xs)/1.4 var(--font-mono);
  background: var(--bg-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
}

.cp-empty {
  padding: 32px 16px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.cp-footer {
  display: flex;
  gap: var(--space-4);
  padding: 8px 14px;
  color: var(--text-muted);
  font-size: var(--text-2xs);
  background: var(--bg-3);
  border-top: 1px solid var(--border);
}

.cp-footer kbd {
  padding: 1px 5px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: inherit;
  background: var(--bg-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
}

@keyframes cp-overlay-in {
  from { opacity: 0; }
}

@keyframes cp-panel-in {
  from { opacity: 0; transform: translateY(-8px) scale(.985); }
}

@media (max-width: 600px) {
  .cp-overlay { align-items: flex-start; padding: max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom)); }
  .cp-panel { max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - max(24px, env(safe-area-inset-top) + env(safe-area-inset-bottom))); }
  .cp-footer { display: none; }
  .cp-item-shortcut { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .cp-overlay,
  .cp-panel { animation: none; }
  .cp-item { transition: none; }
}
</style>

export type NativeLocale = 'tr' | 'en' | 'es' | 'ru' | 'ja' | 'ko' | 'zh' | 'pt' | 'de' | 'fr';

export type NativeTextKey =
  | 'openBridge' | 'notifications' | 'voiceDiagnostics' | 'systemStatus'
  | 'checkUpdates' | 'installRestart' | 'quit' | 'about' | 'view' | 'reload'
  | 'zoomIn' | 'zoomOut' | 'resetZoom' | 'backgroundRunning'
  | 'appStarting'
  | 'updateReadyTitle' | 'updateReadyBodyVersion' | 'updateReadyBody'
  | 'updateCheckFailed' | 'updaterDisabled' | 'noUpdateReady'
  | 'startWithWindows' | 'changeServer' | 'aboutDetail'
  | 'connectTitle' | 'connectHelp' | 'connectLabel' | 'connectButton' | 'connecting'
  | 'connectInvalid' | 'connectInsecure' | 'connectCredentials' | 'connectUnreachable'
  | 'updatesNotConfigured';

type NativeDictionary = Record<NativeTextKey, string>;

const STRINGS: Record<NativeLocale, NativeDictionary> = {
  tr: {
    openBridge: "Bridge'i Aç", notifications: 'Bildirimler', voiceDiagnostics: 'Ses Tanılaması', systemStatus: 'Sistem Durumu',
    checkUpdates: 'Güncellemeleri Kontrol Et', installRestart: 'Güncellemeyi Kur ve Yeniden Başlat', quit: 'Çıkış', about: 'Bridge Hakkında',
    view: 'Görünüm', reload: 'Yenile', zoomIn: 'Yakınlaştır', zoomOut: 'Uzaklaştır', resetZoom: 'Sıfırla',
    backgroundRunning: 'Bridge arka planda çalışmaya devam ediyor.', appStarting: 'Bridge başlatılıyor…',
    updateReadyTitle: 'Bridge güncellemesi hazır', updateReadyBodyVersion: 'v{version} indirildi. Kurmak için Bridge’i yeniden başlat.', updateReadyBody: 'Yeni sürüm indirildi. Kurmak için Bridge’i yeniden başlat.',
    updateCheckFailed: 'Güncelleme kontrolü başarısız oldu.', updaterDisabled: 'Otomatik güncelleme sadece paketlenmiş masaüstü uygulamasında çalışır.', noUpdateReady: 'Kurulmaya hazır indirilmiş güncelleme yok.',
    startWithWindows: 'Windows ile başlat', changeServer: 'Sunucuyu değiştir…', aboutDetail: 'Sürüm {version}', connectTitle: 'Bridge sunucuna bağlan', connectHelp: 'Kullandığın Bridge sunucusunun adresini gir, örneğin chat.example.com.', connectLabel: 'Sunucu adresi', connectButton: 'Bağlan', connecting: 'Bağlanılıyor…', connectInvalid: 'Bu geçerli bir sunucu adresi gibi görünmüyor.', connectInsecure: 'https:// adresi kullan. Düz http:// yalnızca bu bilgisayar için izinlidir.', connectCredentials: 'Adresten kullanıcı adını ve parolayı kaldır.', connectUnreachable: 'Bu adreste bir Bridge sunucusuna ulaşılamadı.', updatesNotConfigured: 'Bu sürümde otomatik güncelleme kapalı.',
  },
  en: {
    openBridge: 'Open Bridge', notifications: 'Notifications', voiceDiagnostics: 'Voice Diagnostics', systemStatus: 'System Status',
    checkUpdates: 'Check for Updates', installRestart: 'Install Update and Restart', quit: 'Quit', about: 'About Bridge',
    view: 'View', reload: 'Reload', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', resetZoom: 'Reset Zoom',
    backgroundRunning: 'Bridge will keep running in the background.', appStarting: 'Starting Bridge…',
    updateReadyTitle: 'Bridge update ready', updateReadyBodyVersion: 'v{version} was downloaded. Restart Bridge to install it.', updateReadyBody: 'A new version was downloaded. Restart Bridge to install it.',
    updateCheckFailed: 'Update check failed.', updaterDisabled: 'Automatic updates are available only in the packaged desktop app.', noUpdateReady: 'No downloaded update is ready to install.',
    startWithWindows: 'Start with Windows', changeServer: 'Change Server…', aboutDetail: 'Version {version}', connectTitle: 'Connect to your Bridge server', connectHelp: 'Enter the address of the Bridge server you use, for example chat.example.com.', connectLabel: 'Server address', connectButton: 'Connect', connecting: 'Connecting…', connectInvalid: 'That doesn\'t look like a server address.', connectInsecure: 'Use an https:// address. Plain http:// is only allowed for this computer.', connectCredentials: 'Remove the username and password from the address.', connectUnreachable: 'Couldn\'t reach a Bridge server at that address.', updatesNotConfigured: 'Automatic updates are turned off for this build.',
  },
  es: {
    openBridge: 'Abrir Bridge', notifications: 'Notificaciones', voiceDiagnostics: 'Diagnóstico de voz', systemStatus: 'Estado del sistema',
    checkUpdates: 'Buscar actualizaciones', installRestart: 'Instalar actualización y reiniciar', quit: 'Salir', about: 'Acerca de Bridge',
    view: 'Ver', reload: 'Recargar', zoomIn: 'Acercar', zoomOut: 'Alejar', resetZoom: 'Restablecer zoom',
    backgroundRunning: 'Bridge seguirá ejecutándose en segundo plano.', appStarting: 'Iniciando Bridge…',
    updateReadyTitle: 'Actualización de Bridge lista', updateReadyBodyVersion: 'Se descargó v{version}. Reinicia Bridge para instalarla.', updateReadyBody: 'Se descargó una nueva versión. Reinicia Bridge para instalarla.',
    updateCheckFailed: 'No se pudo comprobar si hay actualizaciones.', updaterDisabled: 'Las actualizaciones automáticas solo están disponibles en la aplicación de escritorio empaquetada.', noUpdateReady: 'No hay ninguna actualización descargada lista para instalar.',
    startWithWindows: 'Iniciar con Windows', changeServer: 'Cambiar servidor…', aboutDetail: 'Versión {version}', connectTitle: 'Conéctate a tu servidor de Bridge', connectHelp: 'Escribe la dirección del servidor de Bridge que usas, por ejemplo chat.example.com.', connectLabel: 'Dirección del servidor', connectButton: 'Conectar', connecting: 'Conectando…', connectInvalid: 'Eso no parece una dirección de servidor.', connectInsecure: 'Usa una dirección https://. http:// sin cifrar solo se permite para este equipo.', connectCredentials: 'Quita el usuario y la contraseña de la dirección.', connectUnreachable: 'No se pudo contactar con un servidor de Bridge en esa dirección.', updatesNotConfigured: 'Las actualizaciones automáticas están desactivadas en esta compilación.',
  },
  ru: {
    openBridge: 'Открыть Bridge', notifications: 'Уведомления', voiceDiagnostics: 'Диагностика голоса', systemStatus: 'Состояние системы',
    checkUpdates: 'Проверить обновления', installRestart: 'Установить обновление и перезапустить', quit: 'Выход', about: 'О Bridge',
    view: 'Вид', reload: 'Перезагрузить', zoomIn: 'Увеличить', zoomOut: 'Уменьшить', resetZoom: 'Сбросить масштаб',
    backgroundRunning: 'Bridge продолжит работать в фоновом режиме.', appStarting: 'Запуск Bridge…',
    updateReadyTitle: 'Обновление Bridge готово', updateReadyBodyVersion: 'Версия v{version} загружена. Перезапустите Bridge для установки.', updateReadyBody: 'Новая версия загружена. Перезапустите Bridge для установки.',
    updateCheckFailed: 'Не удалось проверить обновления.', updaterDisabled: 'Автоматические обновления доступны только в упакованном настольном приложении.', noUpdateReady: 'Нет загруженного обновления, готового к установке.',
    startWithWindows: 'Запускать вместе с Windows', changeServer: 'Сменить сервер…', aboutDetail: 'Версия {version}', connectTitle: 'Подключитесь к своему серверу Bridge', connectHelp: 'Введите адрес сервера Bridge, которым вы пользуетесь, например chat.example.com.', connectLabel: 'Адрес сервера', connectButton: 'Подключиться', connecting: 'Подключение…', connectInvalid: 'Это не похоже на адрес сервера.', connectInsecure: 'Используйте адрес https://. Незащищённый http:// разрешён только для этого компьютера.', connectCredentials: 'Удалите имя пользователя и пароль из адреса.', connectUnreachable: 'Не удалось связаться с сервером Bridge по этому адресу.', updatesNotConfigured: 'В этой сборке автоматические обновления отключены.',
  },
  ja: {
    openBridge: 'Bridgeを開く', notifications: '通知', voiceDiagnostics: '音声診断', systemStatus: 'システム状態',
    checkUpdates: 'アップデートを確認', installRestart: 'アップデートをインストールして再起動', quit: '終了', about: 'Bridgeについて',
    view: '表示', reload: '再読み込み', zoomIn: '拡大', zoomOut: '縮小', resetZoom: 'ズームをリセット',
    backgroundRunning: 'Bridgeはバックグラウンドで実行を続けます。', appStarting: 'Bridgeを起動しています…',
    updateReadyTitle: 'Bridgeのアップデート準備完了', updateReadyBodyVersion: 'v{version}をダウンロードしました。インストールするにはBridgeを再起動してください。', updateReadyBody: '新しいバージョンをダウンロードしました。インストールするにはBridgeを再起動してください。',
    updateCheckFailed: 'アップデートの確認に失敗しました。', updaterDisabled: '自動アップデートはパッケージ版デスクトップアプリでのみ利用できます。', noUpdateReady: 'インストール可能なダウンロード済みアップデートはありません。',
    startWithWindows: 'Windows の起動時に開始', changeServer: 'サーバーを変更…', aboutDetail: 'バージョン {version}', connectTitle: 'Bridge サーバーに接続', connectHelp: '利用している Bridge サーバーのアドレスを入力してください（例: chat.example.com）。', connectLabel: 'サーバーアドレス', connectButton: '接続', connecting: '接続しています…', connectInvalid: 'サーバーアドレスとして認識できません。', connectInsecure: 'https:// のアドレスを使ってください。暗号化されていない http:// はこのコンピューターでのみ使えます。', connectCredentials: 'アドレスからユーザー名とパスワードを削除してください。', connectUnreachable: 'このアドレスの Bridge サーバーに接続できませんでした。', updatesNotConfigured: 'このビルドでは自動アップデートが無効です。',
  },
  ko: {
    openBridge: 'Bridge 열기', notifications: '알림', voiceDiagnostics: '음성 진단', systemStatus: '시스템 상태',
    checkUpdates: '업데이트 확인', installRestart: '업데이트 설치 후 다시 시작', quit: '종료', about: 'Bridge 정보',
    view: '보기', reload: '새로고침', zoomIn: '확대', zoomOut: '축소', resetZoom: '확대/축소 초기화',
    backgroundRunning: 'Bridge는 백그라운드에서 계속 실행됩니다.', appStarting: 'Bridge를 시작하는 중…',
    updateReadyTitle: 'Bridge 업데이트 준비 완료', updateReadyBodyVersion: 'v{version} 다운로드가 완료되었습니다. 설치하려면 Bridge를 다시 시작하세요.', updateReadyBody: '새 버전 다운로드가 완료되었습니다. 설치하려면 Bridge를 다시 시작하세요.',
    updateCheckFailed: '업데이트 확인에 실패했습니다.', updaterDisabled: '자동 업데이트는 패키지된 데스크톱 앱에서만 사용할 수 있습니다.', noUpdateReady: '설치할 준비가 된 다운로드 업데이트가 없습니다.',
    startWithWindows: 'Windows 시작 시 실행', changeServer: '서버 변경…', aboutDetail: '버전 {version}', connectTitle: 'Bridge 서버에 연결', connectHelp: '사용 중인 Bridge 서버 주소를 입력하세요. 예: chat.example.com', connectLabel: '서버 주소', connectButton: '연결', connecting: '연결하는 중…', connectInvalid: '올바른 서버 주소가 아닌 것 같습니다.', connectInsecure: 'https:// 주소를 사용하세요. 암호화되지 않은 http://는 이 컴퓨터에서만 허용됩니다.', connectCredentials: '주소에서 사용자 이름과 비밀번호를 제거하세요.', connectUnreachable: '해당 주소의 Bridge 서버에 연결할 수 없습니다.', updatesNotConfigured: '이 빌드에서는 자동 업데이트가 꺼져 있습니다.',
  },
  zh: {
    openBridge: '打开 Bridge', notifications: '通知', voiceDiagnostics: '语音诊断', systemStatus: '系统状态',
    checkUpdates: '检查更新', installRestart: '安装更新并重启', quit: '退出', about: '关于 Bridge',
    view: '视图', reload: '重新加载', zoomIn: '放大', zoomOut: '缩小', resetZoom: '重置缩放',
    backgroundRunning: 'Bridge 将继续在后台运行。', appStarting: '正在启动 Bridge…',
    updateReadyTitle: 'Bridge 更新已准备好', updateReadyBodyVersion: 'v{version} 已下载。请重启 Bridge 以安装。', updateReadyBody: '新版本已下载。请重启 Bridge 以安装。',
    updateCheckFailed: '检查更新失败。', updaterDisabled: '自动更新仅在已打包的桌面应用中可用。', noUpdateReady: '没有已下载且可安装的更新。',
    startWithWindows: '随 Windows 启动', changeServer: '更换服务器…', aboutDetail: '版本 {version}', connectTitle: '连接到你的 Bridge 服务器', connectHelp: '输入你使用的 Bridge 服务器地址，例如 chat.example.com。', connectLabel: '服务器地址', connectButton: '连接', connecting: '正在连接…', connectInvalid: '这看起来不是有效的服务器地址。', connectInsecure: '请使用 https:// 地址。未加密的 http:// 仅允许用于本机。', connectCredentials: '请从地址中删除用户名和密码。', connectUnreachable: '无法连接到该地址的 Bridge 服务器。', updatesNotConfigured: '此版本已关闭自动更新。',
  },
  pt: {
    openBridge: 'Abrir Bridge', notifications: 'Notificações', voiceDiagnostics: 'Diagnóstico de voz', systemStatus: 'Status do sistema',
    checkUpdates: 'Verificar atualizações', installRestart: 'Instalar atualização e reiniciar', quit: 'Sair', about: 'Sobre o Bridge',
    view: 'Exibir', reload: 'Recarregar', zoomIn: 'Ampliar', zoomOut: 'Reduzir', resetZoom: 'Redefinir zoom',
    backgroundRunning: 'O Bridge continuará em execução em segundo plano.', appStarting: 'Iniciando o Bridge…',
    updateReadyTitle: 'Atualização do Bridge pronta', updateReadyBodyVersion: 'A versão v{version} foi baixada. Reinicie o Bridge para instalar.', updateReadyBody: 'Uma nova versão foi baixada. Reinicie o Bridge para instalar.',
    updateCheckFailed: 'Falha ao verificar atualizações.', updaterDisabled: 'As atualizações automáticas estão disponíveis apenas no aplicativo de desktop empacotado.', noUpdateReady: 'Não há atualização baixada pronta para instalação.',
    startWithWindows: 'Iniciar com o Windows', changeServer: 'Trocar servidor…', aboutDetail: 'Versão {version}', connectTitle: 'Conecte-se ao seu servidor Bridge', connectHelp: 'Digite o endereço do servidor Bridge que você usa, por exemplo chat.example.com.', connectLabel: 'Endereço do servidor', connectButton: 'Conectar', connecting: 'Conectando…', connectInvalid: 'Isso não parece um endereço de servidor.', connectInsecure: 'Use um endereço https://. http:// sem criptografia só é permitido para este computador.', connectCredentials: 'Remova o usuário e a senha do endereço.', connectUnreachable: 'Não foi possível acessar um servidor Bridge nesse endereço.', updatesNotConfigured: 'As atualizações automáticas estão desativadas nesta versão.',
  },
  de: {
    openBridge: 'Bridge öffnen', notifications: 'Benachrichtigungen', voiceDiagnostics: 'Sprachdiagnose', systemStatus: 'Systemstatus',
    checkUpdates: 'Nach Updates suchen', installRestart: 'Update installieren und neu starten', quit: 'Beenden', about: 'Über Bridge',
    view: 'Ansicht', reload: 'Neu laden', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', resetZoom: 'Zoom zurücksetzen',
    backgroundRunning: 'Bridge läuft im Hintergrund weiter.', appStarting: 'Bridge wird gestartet…',
    updateReadyTitle: 'Bridge-Update ist bereit', updateReadyBodyVersion: 'v{version} wurde heruntergeladen. Starte Bridge neu, um das Update zu installieren.', updateReadyBody: 'Eine neue Version wurde heruntergeladen. Starte Bridge neu, um sie zu installieren.',
    updateCheckFailed: 'Update-Prüfung fehlgeschlagen.', updaterDisabled: 'Automatische Updates sind nur in der paketierten Desktop-App verfügbar.', noUpdateReady: 'Es ist kein heruntergeladenes Update zur Installation bereit.',
    startWithWindows: 'Mit Windows starten', changeServer: 'Server wechseln…', aboutDetail: 'Version {version}', connectTitle: 'Mit deinem Bridge-Server verbinden', connectHelp: 'Gib die Adresse deines Bridge-Servers ein, zum Beispiel chat.example.com.', connectLabel: 'Serveradresse', connectButton: 'Verbinden', connecting: 'Verbindung wird hergestellt…', connectInvalid: 'Das sieht nicht wie eine Serveradresse aus.', connectInsecure: 'Verwende eine https://-Adresse. Unverschlüsseltes http:// ist nur für diesen Computer erlaubt.', connectCredentials: 'Entferne Benutzername und Passwort aus der Adresse.', connectUnreachable: 'Unter dieser Adresse war kein Bridge-Server erreichbar.', updatesNotConfigured: 'Automatische Updates sind in diesem Build deaktiviert.',
  },
  fr: {
    openBridge: 'Ouvrir Bridge', notifications: 'Notifications', voiceDiagnostics: 'Diagnostic vocal', systemStatus: 'État du système',
    checkUpdates: 'Rechercher des mises à jour', installRestart: 'Installer la mise à jour et redémarrer', quit: 'Quitter', about: 'À propos de Bridge',
    view: 'Affichage', reload: 'Recharger', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière', resetZoom: 'Réinitialiser le zoom',
    backgroundRunning: 'Bridge continuera à fonctionner en arrière-plan.', appStarting: 'Démarrage de Bridge…',
    updateReadyTitle: 'Mise à jour de Bridge prête', updateReadyBodyVersion: 'La version v{version} a été téléchargée. Redémarrez Bridge pour l’installer.', updateReadyBody: 'Une nouvelle version a été téléchargée. Redémarrez Bridge pour l’installer.',
    updateCheckFailed: 'Échec de la recherche de mises à jour.', updaterDisabled: 'Les mises à jour automatiques sont disponibles uniquement dans l’application de bureau empaquetée.', noUpdateReady: 'Aucune mise à jour téléchargée n’est prête à être installée.',
    startWithWindows: 'Lancer au démarrage de Windows', changeServer: 'Changer de serveur…', aboutDetail: 'Version {version}', connectTitle: 'Connectez-vous à votre serveur Bridge', connectHelp: 'Saisissez l’adresse du serveur Bridge que vous utilisez, par exemple chat.example.com.', connectLabel: 'Adresse du serveur', connectButton: 'Se connecter', connecting: 'Connexion…', connectInvalid: 'Cela ne ressemble pas à une adresse de serveur.', connectInsecure: 'Utilisez une adresse https://. Le http:// non chiffré n’est autorisé que pour cet ordinateur.', connectCredentials: 'Retirez le nom d’utilisateur et le mot de passe de l’adresse.', connectUnreachable: 'Impossible de joindre un serveur Bridge à cette adresse.', updatesNotConfigured: 'Les mises à jour automatiques sont désactivées dans cette version.',
  },
};

const SUPPORTED = new Set<NativeLocale>(Object.keys(STRINGS) as NativeLocale[]);

export function normalizeNativeLocale(input: string | undefined | null): NativeLocale {
  const raw = String(input ?? '').trim().toLowerCase().replace('_', '-');
  const base = raw.split('-')[0] as NativeLocale;
  return SUPPORTED.has(base) ? base : 'en';
}

export function nativeText(
  key: NativeTextKey,
  vars: Record<string, string | number> = {},
  requestedLocale?: string | null,
): string {
  const locale = normalizeNativeLocale(requestedLocale ?? process.env.BRIDGE_LOCALE ?? 'en');
  const template = STRINGS[locale][key] ?? STRINGS.en[key];
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => String(vars[name] ?? `{${name}}`));
}

export const NATIVE_LOCALES: readonly NativeLocale[] = Object.freeze(Object.keys(STRINGS) as NativeLocale[]);

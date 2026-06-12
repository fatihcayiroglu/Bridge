// ecosystem.config.js — Bridge PM2 Cluster Modu Konfigürasyonu
// Oracle Cloud VPS'teki tüm CPU çekirdeklerini tam kapasiteyle kullanır.
// Kullanım: pm2 start ecosystem.config.js

'use strict';

module.exports = {
  apps: [
    {
      // ── Ana Bridge sunucusu ───────────────────────────────
      name:             'bridge',
      script:           './server/dist/index.js',
      cwd:              __dirname,

      // Cluster modu — Oracle Cloud'daki tüm çekirdekleri kullan
      instances:        'max',
      exec_mode:        'cluster',

      // ── Ortam değişkenleri ────────────────────────────────
      env: {
        NODE_ENV:  'development',
        PORT:      3001,
      },
      env_production: {
        NODE_ENV:  'production',
        PORT:      3001,
        // Redis Cluster modu için Socket.IO pub/sub adapter gerekli
        // REDIS_URL env değişkeni deploy sırasında set edilmeli
      },

      // ── Bellek yönetimi ───────────────────────────────────
      max_memory_restart: '1500M',

      // ── Log yönetimi ──────────────────────────────────────
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      error_file:       './logs/bridge-error.log',
      out_file:         './logs/bridge-out.log',
      merge_logs:       true,

      // ── Graceful reload ───────────────────────────────────
      // pm2 reload bridge → SIGINT gönderir, yeni instance 'ready' sinyali verince
      // eski instance graceful_timeout içinde kapanır → sıfır-kesintili güncelleme.
      // Prosedür: npm run build && pm2 reload ecosystem.config.js --only bridge
      wait_ready:        true,
      listen_timeout:    15000,   // yeni instance ready sinyali için max süre (ms)
      kill_timeout:      10000,   // eski instance'a SIGKILL öncesi süre (ms)
      graceful_timeout:  10000,   // aktif bağlantıların bitmesi için bekleme (ms)

      // ── Crash recovery ────────────────────────────────────
      autorestart:      true,
      restart_delay:    2000,
      max_restarts:     10,
      min_uptime:       '30s',

      // ── İzleme ───────────────────────────────────────────
      watch:            false,
      source_map_support: true,

      // ── Node.js flag'leri ─────────────────────────────────
      node_args: [
        '--max-old-space-size=1400',
        '--enable-source-maps',
      ],
    },

    // ── Blue-Green deployment slot'ları ──────────────────────────────────
    // Standart deploy: pm2 reload ecosystem.config.js --only bridge
    // Canary deploy:   bash deploy-canary.sh [--slot green] [--weight 10]
    //
    // bridge-blue  → port 3001 (primary / aktif)
    // bridge-green → port 3002 (standby; deploy-canary.sh başlatır)
    // Nginx, ACTIVE_SLOT env değişkenine göre upstream seçer.
    {
      name:        'bridge-blue',
      script:      './server/dist/index.js',
      cwd:         __dirname,
      instances:   1,
      exec_mode:   'fork',
      autorestart: true,
      restart_delay:        2000,
      max_restarts:         10,
      min_uptime:           '10s',
      wait_ready:           true,
      listen_timeout:       12000,
      kill_timeout:         8000,
      max_memory_restart:   '512M',
      log_date_format:      'YYYY-MM-DD HH:mm:ss Z',
      error_file:           './logs/bridge-blue-error.log',
      out_file:             './logs/bridge-blue-out.log',
      merge_logs:           true,
      node_args:            ['--enable-source-maps'],
      env: {
        NODE_ENV: 'development',
        PORT:     '3001',
        SLOT:     'blue',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT:     '3001',
        SLOT:     'blue',
      },
    },
    {
      name:        'bridge-green',
      script:      './server/dist/index.js',
      cwd:         __dirname,
      instances:   1,
      exec_mode:   'fork',
      autorestart: false,    // Sadece canary deploy sırasında aktif — kendiliğinden başlamaz
      restart_delay:        2000,
      max_restarts:         5,
      min_uptime:           '10s',
      wait_ready:           true,
      listen_timeout:       12000,
      kill_timeout:         8000,
      max_memory_restart:   '512M',
      log_date_format:      'YYYY-MM-DD HH:mm:ss Z',
      error_file:           './logs/bridge-green-error.log',
      out_file:             './logs/bridge-green-out.log',
      merge_logs:           true,
      node_args:            ['--enable-source-maps'],
      env: {
        NODE_ENV: 'development',
        PORT:     '3002',
        SLOT:     'green',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT:     '3002',
        SLOT:     'green',
      },
    },

    // ── Mediasoup SFU worker süreci ───────────────────────────────────────
    // ÖNEMLI: Mediasoup, PM2 cluster fork'larıyla çalışmaz.
    // Kendi iç worker thread'lerini yönetir (child_process.spawn, C++ düzeyinde).
    // 'max' / cluster modu → her PM2 fork ayrı mediasoup worker seti açar
    //   → RTP port çakışması + ses yönlendirme hatası.
    // Çözüm: exec_mode: 'fork' + instances: 1 zorunludur.
    // İç ölçekleme için MEDIASOUP_WORKERS env değişkenini kullanın.
    {
      name:        'bridge-sfu',
      script:      './server/dist/sfu-worker.js',
      cwd:         __dirname,

      // Fork modu zorunlu — cluster modu mediasoup ile uyumsuzdur
      instances:   1,
      exec_mode:   'fork',

      env: {
        NODE_ENV:           'development',
        SFU_PORT:           3002,
        MEDIASOUP_WORKERS:  '1',
      },
      env_production: {
        NODE_ENV:           'production',
        SFU_PORT:           3002,
        // Oracle Cloud'da çekirdek başına 1 mediasoup worker önerilir (max 4)
        MEDIASOUP_WORKERS:  '2',
      },

      max_memory_restart: '800M',
      log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
      error_file:         './logs/sfu-error.log',
      out_file:           './logs/sfu-out.log',
      merge_logs:         true,

      autorestart:   true,
      restart_delay: 3000,
      max_restarts:  10,
      min_uptime:    '30s',

      watch: false,
      node_args: [
        '--max-old-space-size=700',
        '--enable-source-maps',
      ],
    },
  ],
};

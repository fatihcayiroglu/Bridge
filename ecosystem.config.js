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
      // Worker 1.5 GB'ı aşarsa otomatik restart (bellek sızıntısı koruması)
      max_memory_restart: '1500M',

      // ── Log yönetimi ──────────────────────────────────────
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      error_file:       './logs/bridge-error.log',
      out_file:         './logs/bridge-out.log',
      merge_logs:       true,           // Tüm worker loglarını birleştir

      // ── Graceful reload ───────────────────────────────────
      // Zero-downtime deploy: yeni worker hazır olana kadar eski worker canlı kalır
      wait_ready:       true,
      listen_timeout:   10000,          // 10 saniye içinde 'ready' sinyali gelmezse timeout
      kill_timeout:     5000,           // SIGINT → 5 saniye sonra SIGKILL

      // ── Crash recovery ────────────────────────────────────
      autorestart:      true,
      restart_delay:    2000,           // Yeniden başlamadan önce 2 saniye bekle
      max_restarts:     10,             // 10 kez crash → alarm; oto-restart durursa alerting devreye girer
      min_uptime:       '30s',          // 30 saniyeden kısa yaşayan worker kararlı sayılmaz

      // ── İzleme ───────────────────────────────────────────
      watch:            false,          // Production'da dosya izleme kapalı
      source_map_support: true,

      // ── Node.js flag'leri ─────────────────────────────────
      node_args: [
        '--max-old-space-size=1400',    // V8 heap limiti (max_memory_restart ile uyumlu)
        '--enable-source-maps',
      ],
    },
  ],
};

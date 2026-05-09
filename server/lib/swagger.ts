// server/lib/swagger.js
// OpenAPI 3.0 spec + Swagger UI sunucusu
//
// KURULUM:
//   npm install swagger-ui-express
//   server/index.js'e ekle:
//     const { swaggerRouter } = require('./lib/swagger');
//     app.use('/api/docs', swaggerRouter);
//
// Erişim: http://localhost:3001/api/docs

'use strict';

const express          = require('express');
const swaggerUi        = require('swagger-ui-express');

const spec = {
  openapi: '3.0.3',
  info: {
    title:       'Bridge API',
    version:     '46.0.0',
    description: 'Bridge — Açık kaynaklı Discord alternatifi. REST API dökümantasyonu.',
    contact: { name: 'Bridge', url: 'https://github.com/bridge-app/bridge' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/api/v1', description: 'v1 — stabil, önerilen (canonical)' },
    { url: '/api',    description: 'v1 alias — ilerleyen sprint\'lerde deprecated olacak' },
  ],
  tags: [
    { name: 'Auth',        description: 'Kimlik doğrulama & token yönetimi' },
    { name: 'Servers',     description: 'Sunucu yönetimi' },
    { name: 'Channels',    description: 'Kanal yönetimi' },
    { name: 'Messages',    description: 'Mesaj gönderme & alma' },
    { name: 'DM',          description: 'Direkt mesajlar' },
    { name: 'Friends',     description: 'Arkadaşlık sistemi' },
    { name: 'Roles',       description: 'Rol & izin yönetimi' },
    { name: 'Moderation',  description: 'Moderasyon araçları' },
    { name: 'Upload',      description: 'Dosya yükleme' },
    { name: 'Search',      description: 'Mesaj & kullanıcı arama' },
    { name: 'AI',          description: 'Yapay zeka özellikleri' },
    { name: 'Bots',        description: 'Bot API & Webhook' },
    { name: 'Threads',     description: 'Thread sistemi' },
    { name: 'Polls',       description: 'Anket sistemi' },
    { name: 'Activity',    description: 'Kullanıcı aktivite durumu' },
    { name: 'E2E',         description: 'Uçtan uca şifreleme' },
    { name: 'TwoFactor',   description: 'İki faktörlü doğrulama' },
    { name: 'Discover',    description: 'Sunucu keşif' },
    { name: 'Admin',       description: 'Admin dashboard — sadece isAdmin:1 kullanıcılar' },
    { name: 'Health',      description: 'Sistem sağlığı & metrikler' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type:         'http',
        scheme:       'bearer',
        bearerFormat: 'JWT',
        description:  'JWT access token. /api/auth/login\'den alın.',
      },
    },
    responses: {
      Forbidden: {
        description: 'Yetki hatası',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Kaynak bulunamadı',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'Kimlik doğrulama gerekli',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Not found' },
        },
      },
      User: {
        type: 'object',
        properties: {
          _id:          { type: 'string', format: 'uuid' },
          username:     { type: 'string', example: 'john_doe' },
          displayName:  { type: 'string', example: 'John Doe' },
          avatarColor:  { type: 'string', example: '#5865f2' },
          avatarUrl:    { type: 'string', nullable: true },
          status:       { type: 'string', enum: ['online','idle','dnd','offline'] },
          bio:          { type: 'string' },
          website:      { type: 'string' },
          location:     { type: 'string' },
          pronouns:     { type: 'string' },
          bannerColor:  { type: 'string' },
          bannerUrl:    { type: 'string', nullable: true },
          createdAt:    { type: 'integer', description: 'Unix ms timestamp' },
        },
      },
      Server: {
        type: 'object',
        properties: {
          _id:         { type: 'string', format: 'uuid' },
          name:        { type: 'string', example: 'My Server' },
          icon:        { type: 'string', example: '🌐' },
          iconUrl:     { type: 'string', nullable: true },
          bannerUrl:   { type: 'string', nullable: true },
          ownerId:     { type: 'string', format: 'uuid' },
          discoverable:{ type: 'boolean' },
          description: { type: 'string' },
          tags:        { type: 'array', items: { type: 'string' } },
          createdAt:   { type: 'integer' },
        },
      },
      Channel: {
        type: 'object',
        properties: {
          _id:       { type: 'string', format: 'uuid' },
          serverId:  { type: 'string', format: 'uuid' },
          name:      { type: 'string', example: 'general' },
          type:      { type: 'string', enum: ['text','voice','announcement'] },
          topic:     { type: 'string' },
          category:  { type: 'string' },
          order:     { type: 'integer' },
          createdAt: { type: 'integer' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          _id:         { type: 'string', format: 'uuid' },
          channelId:   { type: 'string', format: 'uuid' },
          serverId:    { type: 'string', format: 'uuid' },
          userId:      { type: 'string', format: 'uuid' },
          username:    { type: 'string' },
          displayName: { type: 'string' },
          avatarColor: { type: 'string' },
          content:     { type: 'string' },
          type:        { type: 'string', enum: ['normal','system','file'] },
          fileUrl:     { type: 'string', nullable: true },
          fileName:    { type: 'string', nullable: true },
          fileType:    { type: 'string', nullable: true },
          reactions:   { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
          pinned:      { type: 'boolean' },
          editedAt:    { type: 'integer', nullable: true },
          replyTo:     { type: 'object', nullable: true },
          createdAt:   { type: 'integer' },
        },
      },
      Invite: {
        type: 'object',
        properties: {
          _id:      { type: 'string', format: 'uuid' },
          code:     { type: 'string', example: 'abc123' },
          serverId: { type: 'string', format: 'uuid' },
          expiresAt:{ type: 'integer' },
          maxUses:  { type: 'integer' },
          uses:     { type: 'integer' },
        },
      },
      Role: {
        type: 'object',
        properties: {
          _id:        { type: 'string', format: 'uuid' },
          serverId:   { type: 'string', format: 'uuid' },
          name:       { type: 'string', example: 'Moderator' },
          color:      { type: 'string', example: '#e74c3c' },
          permissions:{ type: 'integer', description: 'Bit field. 1=VIEW, 2=SEND, 4=MANAGE_MESSAGES, 8=KICK, 16=BAN, 32=MANAGE_CHANNELS, 64=ADMINISTRATOR' },
          position:   { type: 'integer' },
          createdAt:  { type: 'integer' },
        },
      },
      Poll: {
        type: 'object',
        properties: {
          _id:         { type: 'string', format: 'uuid' },
          channelId:   { type: 'string', format: 'uuid' },
          question:    { type: 'string' },
          options:     { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, votes: { type: 'array', items: { type: 'string' } } } } },
          multiSelect: { type: 'boolean' },
          expiresAt:   { type: 'integer', nullable: true },
          closed:      { type: 'boolean' },
          createdAt:   { type: 'integer' },
        },
      },
      Thread: {
        type: 'object',
        properties: {
          _id:             { type: 'string', format: 'uuid' },
          channelId:       { type: 'string', format: 'uuid' },
          parentMessageId: { type: 'string', format: 'uuid' },
          name:            { type: 'string' },
          createdBy:       { type: 'string', format: 'uuid' },
          messageCount:    { type: 'integer' },
          lastMessageAt:   { type: 'integer' },
          createdAt:       { type: 'integer' },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          before:  { type: 'string', description: 'Cursor — bu mesaj ID\'sinden öncekiler' },
          limit:   { type: 'integer', default: 50, maximum: 100 },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // ── HEALTH ──────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Sistem sağlığı (Docker HEALTHCHECK)',
        security: [],
        responses: {
          200: { description: 'Sağlıklı', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, uptime: { type: 'integer' }, version: { type: 'string', example: '46.0.0' }, ts: { type: 'integer' }, db: { type: 'string', enum: ['postgresql', 'sqlite'] } } } } } },
          503: { description: 'Hata', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/health/stats': {
      get: {
        tags: ['Health'],
        summary: 'Detaylı sistem metrikleri (sadece internal / development)',
        security: [],
        responses: {
          200: { description: 'Metrikler', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' }, uptime: { type: 'integer' }, db: { type: 'string' }, memory: { type: 'object' }, counts: { type: 'object' } } } } } },
          403: { description: 'Dış IP\'den erişim yasak (production)' },
        },
      },
    },
    '/health/server/{sid}': {
      get: {
        tags: ['Health'],
        summary: 'Sunucu başına istatistik dashboard',
        parameters: [{ name: 'sid', in: 'path', required: true, schema: { type: 'string' }, description: 'Sunucu ID' }],
        responses: {
          200: { description: 'Sunucu istatistikleri', content: { 'application/json': { schema: { type: 'object', properties: { serverId: { type: 'string' }, members: { type: 'integer' }, channels: { type: 'integer' }, totalMessages: { type: 'integer' }, last7Days: { type: 'object' }, topChannels: { type: 'array' } } } } } },
          403: { description: 'Sunucu üyesi değil' },
          404: { description: 'Sunucu bulunamadı' },
        },
      },
    },
    '/health/ice-config': {
      get: {
        tags: ['Health'],
        summary: 'WebRTC ICE sunucu konfigürasyonu',
        responses: {
          200: { description: 'ICE server listesi', content: { 'application/json': { schema: { type: 'object', properties: { iceServers: { type: 'array', items: { type: 'object', properties: { urls: { type: 'string' }, username: { type: 'string' }, credential: { type: 'string' } } } } } } } } },
        },
      },
    },

    // ── ADMIN ────────────────────────────────────────────────
    '/admin/stats': {
      get: {
        tags: ['Admin'], summary: 'Platform geneli istatistikler',
        responses: {
          200: { description: 'İstatistikler', content: { 'application/json': { schema: { type: 'object', properties: { totals: { type: 'object' }, msgsByDay: { type: 'array' }, topServers: { type: 'array' }, topUsers: { type: 'array' } } } } } },
          403: { description: 'Admin değil' },
        },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'], summary: 'Kullanıcıları listele (sayfalı)',
        parameters: [
          { name: 'q',     in: 'query', schema: { type: 'string' },  description: 'Arama terimi (username / email)' },
          { name: 'page',  in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: {
          200: { description: 'Kullanıcı listesi', content: { 'application/json': { schema: { type: 'object', properties: { users: { type: 'array' }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } } } } } },
        },
      },
    },
    '/admin/users/{id}': {
      patch: {
        tags: ['Admin'], summary: 'Kullanıcıyı güncelle (admin yetkisi)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { isAdmin: { type: 'boolean' } } } } } },
        responses: {
          200: { description: 'Güncellendi' },
          400: { description: 'Kendinizi düzenleyemezsiniz' },
          404: { description: 'Kullanıcı bulunamadı' },
        },
      },
      delete: {
        tags: ['Admin'], summary: 'Kullanıcıyı ve verilerini sil',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Silindi' },
          400: { description: 'Kendinizi silemezsiniz' },
          404: { description: 'Kullanıcı bulunamadı' },
        },
      },
    },
    '/admin/servers': {
      get: {
        tags: ['Admin'], summary: 'Tüm sunucuları listele',
        responses: { 200: { description: 'Sunucu listesi' } },
      },
    },
    '/admin/servers/{id}': {
      delete: {
        tags: ['Admin'], summary: 'Sunucuyu ve tüm içeriğini sil',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Silindi' },
          404: { description: 'Sunucu bulunamadı' },
        },
      },
    },
    '/admin/broadcast': {
      post: {
        tags: ['Admin'], summary: 'Tüm bağlı kullanıcılara sistem duyurusu gönder',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1 } } } } } },
        responses: {
          200: { description: 'Gönderildi' },
          400: { description: 'Mesaj gerekli' },
        },
      },
    },
    '/admin/logs': {
      get: {
        tags: ['Admin'], summary: 'Admin işlem geçmişi (son 200)',
        responses: { 200: { description: 'Log listesi' } },
      },
    },
    '/admin/captcha-stats': {
      get: {
        tags: ['Admin'], summary: 'CAPTCHA istatistikleri',
        responses: {
          200: { description: 'CAPTCHA istatistikleri', content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string' }, successCount: { type: 'integer' }, failCount: { type: 'integer' } } } } } },
        },
      },
    },
    '/admin/make-first-admin': {
      post: {
        tags: ['Admin'], summary: 'İlk admin kullanıcısını ata (setup secret ile)',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['secret','username'], properties: { secret: { type: 'string' }, username: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Admin atandı' },
          400: { description: 'Admin zaten mevcut veya kullanıcı bulunamadı' },
          403: { description: 'Geçersiz secret' },
        },
      },
    },

    // ── AUTH ────────────────────────────────────────────────
    '/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Yeni kullanıcı kaydı', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username','password'], properties: { username: { type: 'string', minLength: 3, maxLength: 32 }, password: { type: 'string', minLength: 6 }, displayName: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Başarılı', content: { 'application/json': { schema: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } } } } },
          400: { description: 'Geçersiz istek', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Kullanıcı adı zaten alınmış' },
          429: { description: 'Çok fazla istek' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Giriş yap', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username','password'], properties: { username: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Başarılı', content: { 'application/json': { schema: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } } } } },
          401: { description: 'Geçersiz kimlik bilgileri' },
          429: { description: 'Çok fazla istek' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'], summary: 'Access token yenile', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Yeni token çifti', content: { 'application/json': { schema: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } } } } },
          401: { description: 'Geçersiz / süresi dolmuş refresh token' },
        },
      },
    },
    '/auth/logout-all': {
      post: {
        tags: ['Auth'], summary: 'Tüm oturumları kapat',
        responses: { 200: { description: 'Başarılı' } },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'], summary: 'Kendi profil bilgilerini al',
        responses: { 200: { description: 'Kullanıcı', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
      },
      patch: {
        tags: ['Auth'], summary: 'Profil bilgilerini güncelle (displayName, bio, status vs.)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { displayName: { type: 'string', maxLength: 32 }, bio: { type: 'string', maxLength: 190 }, status: { type: 'string', enum: ['online','idle','dnd','invisible'] }, customStatus: { type: 'string', maxLength: 128 } } } } } },
        responses: { 200: { description: 'Güncellenmiş kullanıcı', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'], summary: 'Oturumu kapat (refresh token iptal)',
        responses: { 200: { description: 'Başarılı' } },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'], summary: 'Şifre değiştir',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['currentPassword','newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 6 } } } } } },
        responses: { 200: { description: 'Başarılı' }, 401: { description: 'Mevcut şifre yanlış' }, 429: { description: 'Çok fazla istek' } },
      },
    },
    '/auth/me/avatar': {
      post: {
        tags: ['Auth'], summary: 'Profil fotoğrafı yükle',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['avatar'], properties: { avatar: { type: 'string', format: 'binary', description: 'JPEG/PNG, max 5 MB' } } } } } },
        responses: { 200: { description: 'Avatar URL', content: { 'application/json': { schema: { type: 'object', properties: { avatarUrl: { type: 'string' } } } } } }, 400: { description: 'Geçersiz dosya formatı' } },
      },
      delete: {
        tags: ['Auth'], summary: 'Profil fotoğrafını kaldır',
        responses: { 200: { description: 'Kaldırıldı' } },
      },
    },
    '/auth/me/banner': {
      post: {
        tags: ['Auth'], summary: 'Banner görseli yükle',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['banner'], properties: { banner: { type: 'string', format: 'binary' } } } } } },
        responses: { 200: { description: 'Banner URL' } },
      },
    },
    '/auth/me/banner-color': {
      patch: {
        tags: ['Auth'], summary: 'Banner rengini güncelle',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['color'], properties: { color: { type: 'string', example: '#5865f2', description: 'Hex renk kodu' } } } } } },
        responses: { 200: { description: 'Güncellendi' } },
      },
    },
    '/auth/captcha-config': {
      get: {
        tags: ['Auth'], summary: 'CAPTCHA konfigürasyonunu al (site key vs.)', security: [],
        responses: { 200: { description: 'Konfigürasyon', content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['hcaptcha','recaptcha','turnstile'] }, siteKey: { type: 'string' } } } } } } },
      },
    },
    '/auth/csrf-token': {
      get: {
        tags: ['Auth'], summary: 'CSRF token al',
        responses: { 200: { description: 'Token', content: { 'application/json': { schema: { type: 'object', properties: { csrfToken: { type: 'string' } } } } } } },
      },
    },

    // ── SERVERS ─────────────────────────────────────────────
    '/servers': {
      get: {
        tags: ['Servers'], summary: 'Üye olunan sunucuları listele',
        responses: { 200: { description: 'Sunucu listesi', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Server' } } } } } },
      },
      post: {
        tags: ['Servers'], summary: 'Yeni sunucu oluştur',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 50 }, icon: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Oluşturulan sunucu', content: { 'application/json': { schema: { $ref: '#/components/schemas/Server' } } } },
          400: { description: 'Geçersiz istek' },
        },
      },
    },
    '/servers/{serverId}': {
      patch: {
        tags: ['Servers'], summary: 'Sunucu adını/ikonunu güncelle',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string' } } } } } },
        responses: { 200: { description: 'Güncellendi' }, 403: { description: 'Yetki yok' } },
      },
      delete: {
        tags: ['Servers'], summary: 'Sunucuyu sil (sadece sahip)',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Silindi' }, 403: { description: 'Yetki yok' } },
      },
    },
    '/servers/{serverId}/join': {
      post: {
        tags: ['Servers'], summary: 'Davet kodu ile sunucuya katıl',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
        responses: { 200: { description: 'Katıldı' }, 404: { description: 'Geçersiz davet' } },
      },
    },
    '/servers/{serverId}/leave': {
      post: {
        tags: ['Servers'], summary: 'Sunucudan ayrıl',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Ayrıldı' } },
      },
    },
    '/servers/{serverId}/invites': {
      post: {
        tags: ['Servers'], summary: 'Davet kodu oluştur',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { maxUses: { type: 'integer', default: 0, description: '0 = sınırsız' }, expiresIn: { type: 'integer', description: 'Saat cinsinden. 0 = süresiz' } } } } } },
        responses: { 200: { description: 'Davet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invite' } } } } },
      },
    },
    '/servers/{serverId}/members': {
      get: {
        tags: ['Servers'], summary: 'Üye listesi',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Üyeler', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
      },
    },

    // ── CHANNELS ────────────────────────────────────────────
    '/servers/{serverId}/channels': {
      get: {
        tags: ['Channels'], summary: 'Sunucunun kanallarını listele',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Kanallar', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Channel' } } } } } },
      },
      post: {
        tags: ['Channels'], summary: 'Yeni kanal oluştur',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['text','voice'], default: 'text' }, topic: { type: 'string' } } } } } },
        responses: { 200: { description: 'Oluşturulan kanal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } }, 403: { description: 'Yetki yok' } },
      },
    },

    // ── MESSAGES ────────────────────────────────────────────
    '/channels/{channelId}/messages': {
      get: {
        tags: ['Messages'], summary: 'Kanal mesajları (cursor tabanlı)',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'before', in: 'query', schema: { type: 'string' }, description: 'Bu mesaj ID\'sinden öncekiler' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: { 200: { description: 'Mesajlar', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } },
      },
    },
    '/channels/{channelId}/messages/{messageId}': {
      delete: {
        tags: ['Messages'], summary: 'Mesajı sil',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Silindi' }, 403: { description: 'Yetki yok — sadece gönderen veya moderatör' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
      patch: {
        tags: ['Messages'], summary: 'Mesajı düzenle',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['content'], properties: { content: { type: 'string', maxLength: 4000 } } } } } },
        responses: { 200: { description: 'Düzenlenmiş mesaj', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } }, 403: { description: 'Sadece gönderen düzenleyebilir' } },
      },
    },
    '/channels/{channelId}/messages/{messageId}/history': {
      get: {
        tags: ['Messages'], summary: 'Mesaj düzenleme geçmişi',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Düzenleme geçmişi', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, editedAt: { type: 'string', format: 'date-time' } } } } } } } },
      },
    },
    '/channels/{channelId}/pinned': {
      get: {
        tags: ['Messages'], summary: 'Sabitlenmiş mesajları listele',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Sabitlenmiş mesajlar', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } },
      },
    },
    '/channels/{channelId}/messages/{messageId}/react': {
      post: {
        tags: ['Messages'], summary: 'Mesaja reaksiyon ekle / kaldır (toggle)',
        parameters: [
          { name: 'channelId',  in: 'path', required: true, schema: { type: 'string' } },
          { name: 'messageId',  in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['emoji'], properties: { emoji: { type: 'string', example: '👍' } } } } } },
        responses: { 200: { description: 'Güncel reaksiyonlar' } },
      },
    },
    '/channels/{channelId}/messages/{messageId}/pin': {
      post: {
        tags: ['Messages'], summary: 'Mesajı sabitle / sabitlemeden kaldır (toggle)',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Güncellendi' }, 403: { description: 'Yetki yok' } },
      },
    },

    // ── SEARCH ──────────────────────────────────────────────
    '/search': {
      get: {
        tags: ['Search'], summary: 'Mesaj ve kullanıcı arama',
        parameters: [
          { name: 'q',        in: 'query', required: true, schema: { type: 'string', minLength: 2 }, description: 'Arama terimi' },
          { name: 'serverId', in: 'query', schema: { type: 'string' }, description: 'Belirli sunucuda ara' },
          { name: 'type',     in: 'query', schema: { type: 'string', enum: ['messages','users'], default: 'messages' } },
        ],
        responses: { 200: { description: 'Sonuçlar', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } }, users: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } } } },
      },
    },

    // ── ROLES ───────────────────────────────────────────────
    '/servers/{serverId}/roles': {
      get: {
        tags: ['Roles'], summary: 'Sunucu rollerini listele',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Roller', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Role' } } } } } },
      },
      post: {
        tags: ['Roles'], summary: 'Yeni rol oluştur',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string' }, permissions: { type: 'integer' } } } } } },
        responses: { 200: { description: 'Oluşturulan rol', content: { 'application/json': { schema: { $ref: '#/components/schemas/Role' } } } } },
      },
    },

    // ── DM ──────────────────────────────────────────────────
    '/dm': {
      get: {
        tags: ['DM'], summary: 'DM konuşmalarını listele',
        responses: { 200: { description: 'Konuşmalar' } },
      },
      post: {
        tags: ['DM'], summary: 'DM konuşması başlat veya bul',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['targetUserId'], properties: { targetUserId: { type: 'string' } } } } } },
        responses: { 200: { description: 'DM konuşması' } },
      },
    },

    // ── FRIENDS ─────────────────────────────────────────────
    '/friends': {
      get: {
        tags: ['Friends'], summary: 'Arkadaş listesi (kabul edilenler + bekleyenler)',
        responses: { 200: { description: 'Arkadaşlar ve bekleyen istekler' } },
      },
    },
    '/friends/request': {
      post: {
        tags: ['Friends'], summary: 'Arkadaşlık isteği gönder',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username'], properties: { username: { type: 'string' } } } } } },
        responses: { 200: { description: 'İstek gönderildi' }, 404: { description: 'Kullanıcı bulunamadı' }, 409: { description: 'Zaten arkadaş veya istek var' } },
      },
    },
    '/friends/{friendshipId}/accept': {
      post: {
        tags: ['Friends'], summary: 'Arkadaşlık isteğini kabul et',
        parameters: [{ name: 'friendshipId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Kabul edildi' } },
      },
    },
    '/friends/{friendshipId}': {
      delete: {
        tags: ['Friends'], summary: 'Arkadaşı sil veya isteği reddet',
        parameters: [{ name: 'friendshipId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Silindi' } },
      },
    },

    // ── MODERATION ──────────────────────────────────────────
    '/servers/{serverId}/moderation/ban': {
      post: {
        tags: ['Moderation'], summary: 'Kullanıcıyı banla',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['targetUserId'], properties: { targetUserId: { type: 'string' }, reason: { type: 'string' } } } } } },
        responses: { 200: { description: 'Banlandı' }, 403: { description: 'Yetki yok' } },
      },
    },
    '/servers/{serverId}/moderation/kick': {
      post: {
        tags: ['Moderation'], summary: 'Kullanıcıyı kick\'le',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['targetUserId'], properties: { targetUserId: { type: 'string' }, reason: { type: 'string' } } } } } },
        responses: { 200: { description: 'Kick\'lendi' }, 403: { description: 'Yetki yok' } },
      },
    },
    '/servers/{serverId}/moderation/timeout': {
      post: {
        tags: ['Moderation'], summary: 'Kullanıcıyı sustur (timeout)',
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['targetUserId','duration'], properties: { targetUserId: { type: 'string' }, duration: { type: 'integer', description: 'Dakika cinsinden' }, reason: { type: 'string' } } } } } },
        responses: { 200: { description: 'Susturuldu' }, 403: { description: 'Yetki yok' } },
      },
    },

    // ── THREADS ─────────────────────────────────────────────
    '/channels/{channelId}/threads': {
      get: {
        tags: ['Threads'], summary: 'Kanaldaki thread\'leri listele',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Thread\'ler', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Thread' } } } } } },
      },
      post: {
        tags: ['Threads'], summary: 'Mesajdan thread başlat',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['messageId','name'], properties: { messageId: { type: 'string' }, name: { type: 'string', maxLength: 100 } } } } } },
        responses: { 200: { description: 'Oluşturulan thread', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thread' } } } } },
      },
    },

    // ── POLLS ───────────────────────────────────────────────
    '/channels/{channelId}/polls': {
      post: {
        tags: ['Polls'], summary: 'Anket oluştur',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['question','options'], properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 }, multiSelect: { type: 'boolean', default: false }, expiresIn: { type: 'integer', description: 'Saat cinsinden' } } } } } },
        responses: { 200: { description: 'Oluşturulan anket', content: { 'application/json': { schema: { $ref: '#/components/schemas/Poll' } } } } },
      },
    },
    '/channels/{channelId}/polls/{pollId}/vote': {
      post: {
        tags: ['Polls'], summary: 'Ankete oy ver / geri çek (toggle)',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'pollId',    in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['optionIndex'], properties: { optionIndex: { type: 'integer' } } } } } },
        responses: { 200: { description: 'Güncellenen anket' } },
      },
    },

    // ── UPLOAD ──────────────────────────────────────────────
    '/upload': {
      post: {
        tags: ['Upload'], summary: 'Dosya yükle (tek parça, max 50MB)',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
        responses: { 200: { description: 'Yükleme URL\'si', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, fileName: { type: 'string' }, fileType: { type: 'string' } } } } } } },
      },
    },
    '/upload/chunk/start': {
      post: {
        tags: ['Upload'], summary: 'Büyük dosya için chunk yükleme başlat',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fileName','fileSize'], properties: { fileName: { type: 'string' }, fileSize: { type: 'integer' }, fileType: { type: 'string' } } } } } },
        responses: { 200: { description: 'Upload ID', content: { 'application/json': { schema: { type: 'object', properties: { uploadId: { type: 'string' } } } } } } },
      },
    },

    // ── AI ──────────────────────────────────────────────────
    '/ai/status': {
      get: {
        tags: ['AI'], summary: 'AI provider durumu',
        responses: { 200: { description: 'Durum', content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['groq','gemini','openrouter','ollama','rules'] }, features: { type: 'object' } } } } } } },
      },
    },
    '/ai/summarize': {
      post: {
        tags: ['AI'], summary: 'Kanal konuşmasını özetle',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, limit: { type: 'integer', default: 50 } } } } } },
        responses: { 200: { description: 'Özet', content: { 'application/json': { schema: { type: 'object', properties: { summary: { type: 'string' } } } } } } },
      },
    },
    '/ai/translate': {
      post: {
        tags: ['AI'], summary: 'Mesajı çevir',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text','targetLang'], properties: { text: { type: 'string' }, targetLang: { type: 'string', example: 'tr' } } } } } },
        responses: { 200: { description: 'Çeviri', content: { 'application/json': { schema: { type: 'object', properties: { translation: { type: 'string' } } } } } } },
      },
    },
    '/ai/suggest': {
      post: {
        tags: ['AI'], summary: 'Akıllı yanıt önerisi al',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['channelId'], properties: { channelId: { type: 'string' }, context: { type: 'integer', default: 10, description: 'Son N mesaj' } } } } } },
        responses: { 200: { description: 'Öneri', content: { 'application/json': { schema: { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'string' } } } } } } } },
      },
    },

    // ── ACTIVITY ────────────────────────────────────────────
    '/activity': {
      post: {
        tags: ['Activity'], summary: 'Aktivite durumu güncelle',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { type: { type: 'string', enum: ['playing','listening','watching','streaming','coding','reading','custom'] }, name: { type: 'string' }, detail: { type: 'string' } } } } } },
        responses: { 200: { description: 'Güncellendi' } },
      },
      delete: {
        tags: ['Activity'], summary: 'Aktiviteyi temizle',
        responses: { 200: { description: 'Temizlendi' } },
      },
    },

    // ── 2FA ─────────────────────────────────────────────────
    '/2fa/setup': {
      post: {
        tags: ['TwoFactor'], summary: '2FA kurulumunu başlat (QR kodu al)',
        responses: { 200: { description: 'QR kodu ve secret', content: { 'application/json': { schema: { type: 'object', properties: { secret: { type: 'string' }, qrCode: { type: 'string', description: 'Data URL' } } } } } } },
      },
    },
    '/2fa/verify': {
      post: {
        tags: ['TwoFactor'], summary: '2FA kodunu doğrula ve aktif et',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^[0-9]{6}$' } } } } } },
        responses: { 200: { description: 'Aktif edildi', content: { 'application/json': { schema: { type: 'object', properties: { backupCodes: { type: 'array', items: { type: 'string' } } } } } } }, 400: { description: 'Geçersiz kod' } },
      },
    },

    // ── E2E ─────────────────────────────────────────────────
    '/e2e/keys': {
      post: {
        tags: ['E2E'], summary: 'Public key yükle',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['publicKey'], properties: { publicKey: { type: 'string', description: 'Base64 encoded public key' } } } } } },
        responses: { 200: { description: 'Kaydedildi' } },
      },
    },
    '/e2e/keys/{userId}': {
      get: {
        tags: ['E2E'], summary: 'Kullanıcının public key\'ini al',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Public key', content: { 'application/json': { schema: { type: 'object', properties: { publicKey: { type: 'string' } } } } } } },
      },
    },

    // ── BOTS ────────────────────────────────────────────────
    '/bots': {
      get: {
        tags: ['Bots'], summary: 'Sunucudaki botları listele',
        parameters: [{ name: 'serverId', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Bot listesi' } },
      },
      post: {
        tags: ['Bots'], summary: 'Yeni bot oluştur',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['serverId','username'], properties: { serverId: { type: 'string' }, username: { type: 'string' }, description: { type: 'string' } } } } } },
        responses: { 200: { description: 'Bot ve token', content: { 'application/json': { schema: { type: 'object', properties: { bot: { type: 'object' }, token: { type: 'string', description: 'Sadece bir kez gösterilir, sakla!' } } } } } } },
      },
    },

    // ── DISCOVER ────────────────────────────────────────────
    '/discover': {
      get: {
        tags: ['Discover'], summary: 'Keşfedilebilir sunucular',
        parameters: [
          { name: 'q',        in: 'query', schema: { type: 'string' }, description: 'Arama terimi' },
          { name: 'tag',      in: 'query', schema: { type: 'string' } },
          { name: 'page',     in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: { 200: { description: 'Sunucular', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Server' } } } } } },
      },
    },

    // ── CHANNELS ────────────────────────────────────────────
    '/servers/{serverId}/channels/{channelId}': {
      patch: {
        tags: ['Channels'], summary: 'Kanalı güncelle', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'serverId',  in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, topic: { type: 'string' }, isNsfw: { type: 'boolean' }, slowmode: { type: 'integer', minimum: 0 } } } } } },
        responses: { 200: { description: 'Güncellendi' }, 403: { $ref: '#/components/responses/Forbidden' } },
      },
      delete: {
        tags: ['Channels'], summary: 'Kanalı sil', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'serverId',  in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Silindi' }, 403: { $ref: '#/components/responses/Forbidden' } },
      },
    },

    // ── GROUP DM ─────────────────────────────────────────────
    '/gdm': {
      get: {
        tags: ['DM'], summary: 'Grup DM listesi', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Grup DM\'ler' } },
      },
      post: {
        tags: ['DM'], summary: 'Grup DM oluştur', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['participants'], properties: { participants: { type: 'array', items: { type: 'string' }, minItems: 2 }, name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Grup DM' } },
      },
    },
    '/gdm/{groupId}/messages': {
      get: {
        tags: ['DM'], summary: 'Grup DM mesajları', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'before',  in: 'query', schema: { type: 'integer' }, description: 'Cursor (createdAt ms)' },
          { name: 'limit',   in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: { 200: { description: 'Mesajlar' } },
      },
      post: {
        tags: ['DM'], summary: 'Grup DM\'e mesaj gönder', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['content'], properties: { content: { type: 'string', maxLength: 2000 } } } } } },
        responses: { 200: { description: 'Mesaj gönderildi' } },
      },
    },

    // ── AUTOMOD ──────────────────────────────────────────────
    '/servers/{serverId}/automod': {
      get: {
        tags: ['Moderation'], summary: 'Otomod kurallarını listele', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Kurallar' } },
      },
      post: {
        tags: ['Moderation'], summary: 'Yeni otomod kuralı ekle', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['type', 'action'], properties: { type: { type: 'string', enum: ['keyword', 'spam', 'mention-spam', 'link', 'caps'] }, trigger: { type: 'string' }, action: { type: 'string', enum: ['delete', 'timeout', 'ban', 'warn'] }, enabled: { type: 'boolean', default: true } } } } } },
        responses: { 201: { description: 'Kural oluşturuldu' } },
      },
    },
    '/servers/{serverId}/automod/{ruleId}': {
      patch: {
        tags: ['Moderation'], summary: 'Otomod kuralını güncelle', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'serverId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ruleId',   in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Güncellendi' } },
      },
      delete: {
        tags: ['Moderation'], summary: 'Otomod kuralını sil', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'serverId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ruleId',   in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Silindi' } },
      },
    },

    // ── WEBHOOKS ─────────────────────────────────────────────
    '/channels/{channelId}/webhooks': {
      get: {
        tags: ['Bots'], summary: 'Kanal webhook\'larını listele', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Webhook listesi' } },
      },
      post: {
        tags: ['Bots'], summary: 'Webhook oluştur', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, avatarUrl: { type: 'string' } } } } } },
        responses: { 200: { description: 'Webhook ve token' } },
      },
    },

    // ── SOUNDBOARD ───────────────────────────────────────────
    '/servers/{serverId}/soundboard': {
      get: {
        tags: ['Servers'], summary: 'Ses panelini getir', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Sesler' } },
      },
      post: {
        tags: ['Servers'], summary: 'Ses yükle', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['audio', 'name'], properties: { audio: { type: 'string', format: 'binary' }, name: { type: 'string' }, emoji: { type: 'string' }, volume: { type: 'number', minimum: 0, maximum: 2 } } } } } },
        responses: { 200: { description: 'Ses yüklendi' } },
      },
    },

    // ── SCHEDULED MESSAGES ───────────────────────────────────
    '/scheduled': {
      get: {
        tags: ['Messages'], summary: 'Zamanlanmış mesajları listele', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Zamanlanmış mesajlar' } },
      },
      post: {
        tags: ['Messages'], summary: 'Mesaj zamanla', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['channelId', 'content', 'sendAt'], properties: { channelId: { type: 'string' }, serverId: { type: 'string' }, content: { type: 'string', maxLength: 2000 }, sendAt: { type: 'integer', description: 'Unix ms timestamp' } } } } } },
        responses: { 201: { description: 'Zamanlandı' } },
      },
    },

    // ── SERVER TEMPLATES ─────────────────────────────────────
    '/server-templates': {
      get: {
        tags: ['Servers'], summary: 'Sunucu şablonlarını listele',
        responses: { 200: { description: 'Şablonlar' } },
      },
    },
    '/server-templates/{code}': {
      get: {
        tags: ['Servers'], summary: 'Şablonu getir',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Şablon' } },
      },
    },

    // ── REACTION ROLES ───────────────────────────────────────
    '/servers/{serverId}/reaction-roles': {
      get: {
        tags: ['Roles'], summary: 'Tepki rollerini listele', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Tepki rolleri' } },
      },
      post: {
        tags: ['Roles'], summary: 'Tepki rolü oluştur', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'serverId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['channelId', 'messageId', 'emoji', 'roleId'], properties: { channelId: { type: 'string' }, messageId: { type: 'string' }, emoji: { type: 'string' }, roleId: { type: 'string' } } } } } },
        responses: { 201: { description: 'Oluşturuldu' } },
      },
    },

    // ── WEBAUTHN ─────────────────────────────────────────────
    '/webauthn/register/options': {
      post: {
        tags: ['Auth'], summary: 'WebAuthn kayıt seçenekleri', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'PublicKeyCredentialCreationOptions' } },
      },
    },
    '/webauthn/register/verify': {
      post: {
        tags: ['Auth'], summary: 'WebAuthn kaydını tamamla', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Passkey kaydedildi' } },
      },
    },
    '/webauthn/authenticate/options': {
      post: {
        tags: ['Auth'], summary: 'WebAuthn giriş seçenekleri',
        responses: { 200: { description: 'PublicKeyCredentialRequestOptions' } },
      },
    },
    '/webauthn/authenticate/verify': {
      post: {
        tags: ['Auth'], summary: 'WebAuthn girişini tamamla',
        responses: { 200: { description: 'JWT ve refresh token' } },
      },
    },

    // ── VOICE MESSAGES ───────────────────────────────────────
    '/voice-messages': {
      post: {
        tags: ['Messages'], summary: 'Sesli mesaj gönder', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['audio', 'channelId'], properties: { audio: { type: 'string', format: 'binary' }, channelId: { type: 'string' }, serverId: { type: 'string' }, duration: { type: 'number' } } } } } },
        responses: { 200: { description: 'Sesli mesaj gönderildi' } },
      },
    },

    // ── CLIENT ERROR REPORTING ───────────────────────────────
    '/client-error': {
      post: {
        tags: ['Health'], summary: 'İstemci hata raporu gönder',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { type: { type: 'string', enum: ['uncaught', 'unhandledrejection', 'resource', 'manual', 'crash'] }, message: { type: 'string', maxLength: 2000 }, source: { type: 'string' }, line: { type: 'integer' }, col: { type: 'integer' }, stack: { type: 'string' } } } } } },
        responses: { 204: { description: 'Rapor alındı' }, 400: { description: 'Geçersiz payload' } },
      },
    },
    '/client-error/stats': {
      get: {
        tags: ['Health'], summary: 'İstemci hata istatistikleri (sadece admin)', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'İstatistikler' }, 403: { $ref: '#/components/responses/Forbidden' } },
      },
    },
  },
};

// ── Swagger UI Router ─────────────────────────────────────────
const swaggerRouter = express.Router();

swaggerRouter.get('/spec.json', (req, res) => res.json(spec));

try {
  swaggerRouter.use('/', swaggerUi.serve);
  swaggerRouter.get('/', swaggerUi.setup(spec, {
    customSiteTitle: 'Bridge API Docs',
    customCss: `
      .swagger-ui .topbar { background: #5865f2; }
      .swagger-ui .topbar-wrapper img { display: none; }
      .swagger-ui .topbar-wrapper::before { content: '🌉 Bridge API'; color: white; font-size: 1.4em; font-weight: bold; }
    `,
    swaggerOptions: { persistAuthorization: true },
  }));
} catch {
  // swagger-ui-express yüklü değilse spec endpoint'i yeterli
  swaggerRouter.get('/', (req, res) => {
    res.send('<h2>Swagger UI yüklü değil</h2><p>npm install swagger-ui-express</p><p><a href="spec.json">spec.json\'u görüntüle</a></p>');
  });
}

module.exports = { swaggerRouter, spec };
export {};

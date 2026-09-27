// server/lib/mailer.ts — Nodemailer e-posta gönderici
// SMTP veya Resend/Sendgrid API destekler
// E-posta yoksa konsola basar (development modu)

import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import logger from './logger';
import { envSafeInt } from './envNumbers';

/**
 * Bu modülün gerçekten kullandığı YÜZEY.
 *
 * Eskiden `Pick<Transporter, 'sendMail'>` yazılıydı. Nodemailer 10 ile
 * `sendMail` AŞIRI YÜKLENMİŞ bir imzaya sahip (promise + callback), ve
 * geliştirme/test taşıyıcısı yalnızca promise biçimini uygular; bu yüzden
 * kütüphane tipini ödünç almak yanlış bir sözleşme ilan ediyordu.
 * Uygulama tek bir çağrı biçimi kullanır: `await sendMail(options)`.
 */
interface MailSender {
  sendMail(options: SendMailOptions): Promise<{ messageId?: string }>;
}

let _transporter: MailSender | null = null;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTransporter(): MailSender {
  if (_transporter) return _transporter;

  if (process.env.SMTP_HOST) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port: envSafeInt('SMTP_PORT', 587, { min: 1, max: 65_535 }),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else {
    // A production instance must never pretend that a verification/reset
    // message was sent when no SMTP authority exists. In development/test we
    // keep a non-network transport, but deliberately do not log message bodies
    // because they contain single-use verification/reset credentials.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST is required for production email delivery');
    }
    _transporter = {
      sendMail: async (opts: SendMailOptions) => {
        logger.info({ to: opts.to, subject: opts.subject, event: 'mailer.dev.sent' }, '📧 [DEV MAIL]');
        return { messageId: 'dev-' + Date.now() };
      }
    };
  }
  return _transporter;
}

const FROM = process.env.SMTP_FROM || '"Bridge" <noreply@bridge.local>';
const BASE = process.env.INSTANCE_URL || 'http://localhost:3001';

async function sendVerificationEmail(email: string, token: string, username: string): Promise<void> {
  const url = `${BASE}/api/email/verify?token=${encodeURIComponent(token)}`;
  const safeUsername = escapeHtml(username);
  await getTransporter().sendMail({
    from:    FROM,
    to:      email,
    subject: 'Bridge — E-posta Adresinizi Doğrulayın',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#2d9cdb;">🌉 Bridge</h2>
        <p>Merhaba <strong>${safeUsername}</strong>,</p>
        <p>E-posta adresinizi doğrulamak için aşağıdaki butona tıklayın:</p>
        <a href="${url}" style="display:inline-block;background:#2d9cdb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          ✅ E-postamı Doğrula
        </a>
        <p style="color:#666;font-size:13px;">Link 24 saat geçerlidir. Tıklamazsanız hesabınız çalışmaya devam eder ancak bazı özellikler kısıtlanabilir.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
        <p style="color:#999;font-size:12px;">Bu e-postayı siz almadıysanız görmezden gelebilirsiniz.</p>
      </div>`,
  });
}

async function sendPasswordResetEmail(email: string, token: string, username: string): Promise<void> {
  const url = `${BASE}/reset-password?token=${encodeURIComponent(token)}`;
  const safeUsername = escapeHtml(username);
  await getTransporter().sendMail({
    from:    FROM,
    to:      email,
    subject: 'Bridge — Şifre Sıfırlama',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#2d9cdb;">🌉 Bridge</h2>
        <p>Merhaba <strong>${safeUsername}</strong>,</p>
        <p>Şifrenizi sıfırlamak için aşağıdaki butona tıklayın:</p>
        <a href="${url}" style="display:inline-block;background:#e8432d;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          🔑 Şifremi Sıfırla
        </a>
        <p style="color:#666;font-size:13px;">Link 1 saat geçerlidir. Siz talep etmediyseniz bu e-postayı görmezden gelin.</p>
      </div>`,
  });
}

async function sendSuspiciousLoginAlert({ to, username, ip, userAgent, time }: {
  to: string;
  username: string;
  ip: string;
  userAgent: string;
  time: string;
}): Promise<void> {
  const safeUsername = escapeHtml(username);
  const safeIp = escapeHtml(ip);
  const safeUserAgent = escapeHtml(userAgent);
  const safeTime = escapeHtml(time);
  await getTransporter().sendMail({
    from:    FROM,
    to,
    subject: 'Bridge — Yeni Cihazdan Giriş Yapıldı',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#2d9cdb;">🌉 Bridge — Güvenlik Uyarısı</h2>
        <p>Merhaba <strong>${safeUsername}</strong>,</p>
        <p>Hesabınıza <strong>yeni bir cihaz veya konumdan</strong> giriş yapıldı:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
          <tr><td style="padding:8px;color:#666;width:120px;">🕐 Zaman</td><td style="padding:8px;"><strong>${safeTime}</strong></td></tr>
          <tr style="background:#f5f5f5;"><td style="padding:8px;color:#666;">🌐 IP Adresi</td><td style="padding:8px;"><strong>${safeIp}</strong></td></tr>
          <tr><td style="padding:8px;color:#666;">💻 Cihaz</td><td style="padding:8px;font-size:12px;color:#555;">${safeUserAgent}</td></tr>
        </table>
        <p style="color:#e8432d;font-weight:600;">Bu giriş siz değilseniz şifrenizi hemen değiştirin!</p>
        <a href="${BASE}/settings" style="display:inline-block;background:#e8432d;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0;">
          🔒 Şifremi Değiştir
        </a>
        <p style="color:#999;font-size:12px;margin-top:16px;">Bu giriş sizin tarafınızdan yapıldıysa bu e-postayı görmezden gelebilirsiniz.</p>
      </div>`,
  });
}

export { sendVerificationEmail, sendPasswordResetEmail, sendSuspiciousLoginAlert };

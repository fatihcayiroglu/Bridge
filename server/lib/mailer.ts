// @ts-nocheck
// server/lib/mailer.js — Nodemailer e-posta gönderici
// SMTP veya Resend/Sendgrid API destekler
// E-posta yoksa konsola basar (development modu)

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (process.env.SMTP_HOST) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else {
    // Development: Ethereal (otomatik test hesabı) veya konsol
    _transporter = {
      sendMail: async (opts) => {
        console.log('\n📧 [DEV MAIL] To:', opts.to);
        console.log('   Subject:', opts.subject);
        // HTML'den düz metin çıkar
        const text = (opts.html || opts.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log('   Body:', text.slice(0, 200));
        return { messageId: 'dev-' + Date.now() };
      }
    };
  }
  return _transporter;
}

const FROM = process.env.SMTP_FROM || '"Bridge" <noreply@bridge.local>';
const BASE = process.env.INSTANCE_URL || 'http://localhost:3001';

async function sendVerificationEmail(email, token, username) {
  const url = `${BASE}/api/email/verify?token=${token}`;
  await getTransporter().sendMail({
    from:    FROM,
    to:      email,
    subject: 'Bridge — E-posta Adresinizi Doğrulayın',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#5865f2;">🌉 Bridge</h2>
        <p>Merhaba <strong>${username}</strong>,</p>
        <p>E-posta adresinizi doğrulamak için aşağıdaki butona tıklayın:</p>
        <a href="${url}" style="display:inline-block;background:#5865f2;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          ✅ E-postamı Doğrula
        </a>
        <p style="color:#666;font-size:13px;">Link 24 saat geçerlidir. Tıklamazsanız hesabınız çalışmaya devam eder ancak bazı özellikler kısıtlanabilir.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
        <p style="color:#999;font-size:12px;">Bu e-postayı siz almadıysanız görmezden gelebilirsiniz.</p>
      </div>`,
  });
}

async function sendPasswordResetEmail(email, token, username) {
  const url = `${BASE}/reset-password?token=${token}`;
  await getTransporter().sendMail({
    from:    FROM,
    to:      email,
    subject: 'Bridge — Şifre Sıfırlama',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#5865f2;">🌉 Bridge</h2>
        <p>Merhaba <strong>${username}</strong>,</p>
        <p>Şifrenizi sıfırlamak için aşağıdaki butona tıklayın:</p>
        <a href="${url}" style="display:inline-block;background:#e8432d;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          🔑 Şifremi Sıfırla
        </a>
        <p style="color:#666;font-size:13px;">Link 1 saat geçerlidir. Siz talep etmediyseniz bu e-postayı görmezden gelin.</p>
      </div>`,
  });
}

async function sendSuspiciousLoginAlert({ to, username, ip, userAgent, time }) {
  await getTransporter().sendMail({
    from:    FROM,
    to,
    subject: 'Bridge — Yeni Cihazdan Giriş Yapıldı',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#5865f2;">🌉 Bridge — Güvenlik Uyarısı</h2>
        <p>Merhaba <strong>${username}</strong>,</p>
        <p>Hesabınıza <strong>yeni bir cihaz veya konumdan</strong> giriş yapıldı:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
          <tr><td style="padding:8px;color:#666;width:120px;">🕐 Zaman</td><td style="padding:8px;"><strong>${time}</strong></td></tr>
          <tr style="background:#f5f5f5;"><td style="padding:8px;color:#666;">🌐 IP Adresi</td><td style="padding:8px;"><strong>${ip}</strong></td></tr>
          <tr><td style="padding:8px;color:#666;">💻 Cihaz</td><td style="padding:8px;font-size:12px;color:#555;">${userAgent}</td></tr>
        </table>
        <p style="color:#e8432d;font-weight:600;">Bu giriş siz değilseniz şifrenizi hemen değiştirin!</p>
        <a href="${BASE}/settings" style="display:inline-block;background:#e8432d;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:8px 0;">
          🔒 Şifremi Değiştir
        </a>
        <p style="color:#999;font-size:12px;margin-top:16px;">Bu giriş sizin tarafınızdan yapıldıysa bu e-postayı görmezden gelebilirsiniz.</p>
      </div>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendSuspiciousLoginAlert };
export {};

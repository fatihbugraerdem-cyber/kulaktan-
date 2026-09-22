// lib/email.js
// Sends real email via the Resend HTTP API (https://resend.com) using Node's
// built-in `fetch` — no mail library needed. If RESEND_API_KEY isn't set,
// it transparently logs the email instead of pretending to send it.
// Swap the fetch call below for any other transactional-email HTTP API
// (Postmark, SendGrid, etc.) if you prefer — same idea.
'use strict';
const db = require('./db');

async function sendEmail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  let status = 'LOGLANDI (SMTP/API anahtarı tanımlı değil, gerçek e-posta gönderilmedi)';

  if (apiKey) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Kulaktan <bildirim@kulaktan.example>',
          to: [to],
          subject,
          text,
        }),
      });
      status = resp.ok ? 'GÖNDERİLDİ' : `HATA (HTTP ${resp.status})`;
    } catch (e) {
      status = `HATA (${e.message})`;
    }
  } else {
    // Dev/setup convenience: print the full email to the server console so
    // things like password-reset links are still usable while you're
    // setting up a real email provider.
    console.log(`\n[E-POSTA - GÖNDERİLMEDİ, sadece konsola yazdırıldı]\nKime: ${to}\nKonu: ${subject}\n${text}\n`);
  }

  db.prepare('INSERT INTO email_log (to_email, subject, status) VALUES (?, ?, ?)').run(to, subject, status);
  return status;
}

module.exports = { sendEmail };

// server.js
// Kulaktan backend. Built entirely on Node.js core modules (http, node:sqlite,
// crypto, fetch) — no npm install required or expected.
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

const db = require('./lib/db');
const cr = require('./lib/crypto');
const { readJsonBody, sendJson, serveStatic, applySecurityHeaders } = require('./lib/http-utils');
const { createSession, getSessionUser, requireRole, requireCsrf, destroySession, destroyAllSessionsForUser } = require('./lib/auth');
const { sendEmail } = require('./lib/email');
const { checkRateLimit, clientIp } = require('./lib/rate-limit');
const { getOrCreateOrganization, createStaffAccount, updateOrgBranding, listStaffForOrg, updateStaffAccount, deleteStaffAccount } = require('./lib/org-helpers');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const EVIDENCE_MIME_ALLOWLIST = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

// ---- audit (now hash-chained for tamper evidence) --------------------------

function audit(organizationId, caseCode, actor, action) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.hash : null;
  const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const hash = cr.computeAuditHash(prevHash, { organization_id: organizationId, case_code: caseCode, actor, action, created_at: createdAt });
  db.prepare('INSERT INTO audit_log (organization_id, case_code, actor, action, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(organizationId, caseCode, actor, action, prevHash, hash, createdAt);
}

function verifyAuditChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prevHash = null;
  for (const row of rows) {
    const expected = cr.computeAuditHash(prevHash, row);
    if (expected !== row.hash) return { intact: false, brokenAt: row.id };
    prevHash = row.hash;
  }
  return { intact: true, brokenAt: null };
}

// ---- helpers ----------------------------------------------------------------

function findCaseByCode(code) {
  return db.prepare(`
    SELECT cases.*, users.name as expert_name
    FROM cases LEFT JOIN users ON users.id = cases.expert_id
    WHERE cases.code = ?
  `).get(code);
}

function caseToJson(row, { summary = false, opinion = false, decision = false, messages = false } = {}) {
  const out = {
    code: row.code,
    company: row.company,
    category: row.category,
    department: row.department,
    status: row.status,
    expert: row.expert_name || 'Atanmadı',
    hasEvidence: !!row.evidence_enc,
    evidenceFilename: row.evidence_filename || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (summary) out.summary = cr.decrypt(row.summary_enc);
  if (opinion) out.opinion = row.opinion_enc ? cr.decrypt(row.opinion_enc) : 'Henüz mütalaa yazılmadı.';
  if (decision) out.boardDecision = row.board_decision_enc ? cr.decrypt(row.board_decision_enc) : null;
  if (messages) {
    const msgs = db.prepare('SELECT sender_role, text_enc, created_at FROM messages WHERE case_id = ? ORDER BY id ASC').all(row.id);
    out.messages = msgs.map((m) => ({ sender: m.sender_role, text: cr.decrypt(m.text_enc), createdAt: m.created_at }));
  }
  return out;
}

function generateUniqueCaseCode() {
  for (let i = 0; i < 20; i++) {
    const code = cr.genCaseCode();
    if (!db.prepare('SELECT 1 FROM cases WHERE code = ?').get(code)) return code;
  }
  throw new Error('Benzersiz dosya kodu üretilemedi.');
}

function getOrgBySlug(slug) {
  return db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug);
}

function rateLimited(req, res, key, max, windowMs, message) {
  const { allowed, retryAfterMs } = checkRateLimit(key, max, windowMs);
  if (!allowed) {
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
    sendJson(res, 429, { success: false, error: message || 'Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin.' });
    return true;
  }
  return false;
}

// ---- public: case submission / tracking / messaging -------------------------

async function handleSubmitCase(req, res) {
  if (rateLimited(req, res, `submit:${clientIp(req)}`, 10, 60 * 60 * 1000, 'Çok fazla bildirim gönderildi. Lütfen daha sonra tekrar deneyin.')) return;

  const body = await readJsonBody(req);
  const { company, category, department, summary, organizationSlug } = body;
  if (!company || !category || !summary || summary.trim().length < 5) {
    return sendJson(res, 400, { success: false, error: 'Zorunlu alanlar eksik: kurum, kategori ve olay özeti gereklidir.' });
  }

  const org = getOrgBySlug(organizationSlug || 'default');
  if (!org) return sendJson(res, 404, { success: false, error: 'Geçersiz organizasyon bağlantısı.' });

  let evidenceEnc = null;
  if (body.evidenceBase64) {
    if (Buffer.byteLength(body.evidenceBase64, 'base64') > 15 * 1024 * 1024) {
      return sendJson(res, 400, { success: false, error: 'Kanıt dosyası 15MB sınırını aşıyor.' });
    }
    if (body.evidenceMimeType && !EVIDENCE_MIME_ALLOWLIST.has(body.evidenceMimeType)) {
      return sendJson(res, 400, { success: false, error: 'Desteklenmeyen dosya türü. İzin verilen türler: PDF, Word, Excel, resim (PNG/JPEG/WEBP), metin/CSV.' });
    }
    evidenceEnc = cr.encryptBuffer(Buffer.from(body.evidenceBase64, 'base64'));
  }

  const code = generateUniqueCaseCode();
  const accessToken = cr.randomToken(16);
  const accessTokenHash = cr.hashToken(accessToken);

  db.prepare(`
    INSERT INTO cases (organization_id, code, access_token_hash, company, category, department, summary_enc,
      evidence_filename, evidence_mime, evidence_enc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Kritik / Yeni')
  `).run(org.id, code, accessTokenHash, company, category, department || null, cr.encrypt(summary),
    body.evidenceFilename || null, body.evidenceMimeType || null, evidenceEnc);

  audit(org.id, code, 'Anonim İhbarcı', 'Yeni ihbar oluşturuldu ve sunucuda AES-256-GCM ile şifrelenerek mühürlendi.');
  await sendEmail(process.env.COMPLIANCE_EMAIL || 'compliance@kulaktan.local', `Yeni İhbar Alındı (${code})`,
    `Yeni bir ihbar sisteme kaydedildi. Dosya kodu: ${code}. Kategori: ${category}.`);

  sendJson(res, 201, {
    success: true,
    code,
    accessToken,
    message: 'Bildiriminiz alındı. Kodunuzu ve erişim anahtarınızı güvenli bir yerde saklayın — bir daha gösterilmeyecek.',
  });
}

async function handleTrackCase(req, res, query) {
  if (rateLimited(req, res, `track:${clientIp(req)}`, 30, 10 * 60 * 1000)) return;

  const code = (query.get('code') || '').trim().toUpperCase();
  const token = (query.get('token') || '').trim();
  if (!code || !token) return sendJson(res, 400, { success: false, error: 'Kod ve erişim anahtarı gereklidir.' });

  const row = findCaseByCode(code);
  if (!row || cr.hashToken(token) !== row.access_token_hash) {
    return sendJson(res, 404, { success: false, error: 'Girilen koda ve anahtara ait bir dosya bulunamadı.' });
  }
  sendJson(res, 200, { success: true, case: caseToJson(row, { decision: true, messages: true }) });
}

async function handleWhistleblowerMessage(req, res) {
  if (rateLimited(req, res, `msg:${clientIp(req)}`, 20, 10 * 60 * 1000)) return;

  const body = await readJsonBody(req);
  const code = (body.code || '').trim().toUpperCase();
  const token = (body.token || '').trim();
  const text = (body.text || '').trim();
  if (!text) return sendJson(res, 400, { success: false, error: 'Mesaj boş olamaz.' });

  const row = findCaseByCode(code);
  if (!row || cr.hashToken(token) !== row.access_token_hash) {
    return sendJson(res, 404, { success: false, error: 'Girilen koda ve anahtara ait bir dosya bulunamadı.' });
  }
  db.prepare('INSERT INTO messages (case_id, sender_role, text_enc) VALUES (?, ?, ?)').run(row.id, 'whistleblower', cr.encrypt(text));
  sendJson(res, 200, { success: true });
}

function handleOrgPublicInfo(req, res, slug) {
  const org = getOrgBySlug(slug);
  if (!org) return sendJson(res, 404, { success: false, error: 'Organizasyon bulunamadı.' });
  sendJson(res, 200, { success: true, organization: { name: org.name, slug: org.slug, primaryColor: org.primary_color } });
}

// ---- auth: login / logout / me / password reset -----------------------------

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (rateLimited(req, res, `login-ip:${ip}`, 20, 10 * 60 * 1000)) return;

  const { username, password } = await readJsonBody(req);
  if (!username || !password) return sendJson(res, 400, { success: false, error: 'Kullanıcı adı ve şifre gereklidir.' });

  if (rateLimited(req, res, `login-user:${username}`, LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MS,
      'Çok fazla başarısız deneme. Hesabınız geçici olarak kilitlendi, lütfen 15 dakika sonra tekrar deneyin.')) return;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());

  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    return sendJson(res, 423, { success: false, error: 'Hesap geçici olarak kilitli. Lütfen daha sonra tekrar deneyin veya şifrenizi sıfırlayın.' });
  }

  if (!user || !cr.verifyPassword(password, user.password_hash)) {
    if (user) {
      const attempts = user.failed_attempts + 1;
      const lockedUntil = attempts >= LOGIN_MAX_ATTEMPTS ? new Date(Date.now() + LOGIN_LOCKOUT_MS).toISOString() : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockedUntil, user.id);
    }
    return sendJson(res, 401, { success: false, error: 'Kullanıcı adı veya şifre hatalı.' });
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  createSession(res, user);
  sendJson(res, 200, { success: true, role: user.role, name: user.name });
}

function handleLogout(req, res) {
  destroySession(req, res);
  sendJson(res, 200, { success: true });
}

function handleMe(req, res) {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 200, { success: true, user: null });
  sendJson(res, 200, { success: true, user: { role: user.role, name: user.name } });
}

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

async function handleRequestReset(req, res) {
  if (rateLimited(req, res, `reset-req:${clientIp(req)}`, 5, 15 * 60 * 1000)) return;

  const { username } = await readJsonBody(req);
  // Always return the same generic response, whether or not the account
  // exists — this avoids leaking which usernames are valid.
  const generic = { success: true, message: 'Eğer bu kullanıcı adına ait bir hesap varsa, sıfırlama bağlantısı e-posta ile gönderildi.' };

  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim()) : null;
  if (user) {
    const token = cr.randomToken(24);
    const tokenHash = cr.hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);
    const resetUrl = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
    await sendEmail(user.email, 'Kulaktan Şifre Sıfırlama', `Şifrenizi sıfırlamak için: ${resetUrl}\nBu bağlantı 30 dakika geçerlidir.`);
  }
  sendJson(res, 200, generic);
}

async function handleResetPassword(req, res) {
  if (rateLimited(req, res, `reset-do:${clientIp(req)}`, 10, 15 * 60 * 1000)) return;

  const { token, newPassword } = await readJsonBody(req);
  if (!token || !newPassword || newPassword.length < 8) {
    return sendJson(res, 400, { success: false, error: 'Geçersiz istek. Şifre en az 8 karakter olmalıdır.' });
  }
  const tokenHash = cr.hashToken(token);
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash);
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return sendJson(res, 400, { success: false, error: 'Sıfırlama bağlantısının süresi dolmuş veya zaten kullanılmış.' });
  }

  db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(cr.hashPassword(newPassword), row.user_id);
  db.prepare('UPDATE password_resets SET used_at = datetime(\'now\') WHERE id = ?').run(row.id);
  destroyAllSessionsForUser(row.user_id); // any stolen session dies with the old password

  sendJson(res, 200, { success: true, message: 'Şifreniz güncellendi. Şimdi yeni şifrenizle giriş yapabilirsiniz.' });
}

// ---- public contact form ------------------------------------------------

async function handleContactForm(req, res) {
  if (rateLimited(req, res, `contact:${clientIp(req)}`, 5, 15 * 60 * 1000, 'Çok fazla mesaj gönderildi. Lütfen daha sonra tekrar deneyin.')) return;

  const { name, email, company, message } = await readJsonBody(req);
  if (!name || !email || !message || message.trim().length < 10) {
    return sendJson(res, 400, { success: false, error: 'Ad, e-posta ve en az 10 karakterlik bir mesaj gereklidir.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(res, 400, { success: false, error: 'Geçerli bir e-posta adresi giriniz.' });
  }

  const to = process.env.CONTACT_EMAIL || process.env.COMPLIANCE_EMAIL || 'info@kulaktan.com.tr';
  await sendEmail(to, `Web Sitesi İletişim Formu — ${name}`,
    `Ad: ${name}\nE-posta: ${email}\nŞirket: ${company || '-'}\n\nMesaj:\n${message}`);

  sendJson(res, 200, { success: true, message: 'Mesajınız alındı. En kısa sürede size dönüş yapacağız.' });
}

// ---- admin (organization-scoped) ---------------------------------------------

function handleAdminCases(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  const rows = db.prepare(`
    SELECT cases.*, users.name as expert_name
    FROM cases LEFT JOIN users ON users.id = cases.expert_id
    WHERE cases.organization_id = ?
    ORDER BY cases.created_at DESC
  `).all(user.organization_id);
  sendJson(res, 200, { success: true, cases: rows.map((r) => caseToJson(r, { summary: true, opinion: true, decision: true })) });
}

function handleAdminExperts(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  const rows = db.prepare("SELECT id, name FROM users WHERE role = 'expert' AND organization_id = ? ORDER BY name").all(user.organization_id);
  sendJson(res, 200, { success: true, experts: rows });
}

async function handleAdminAssign(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { code, expertId } = await readJsonBody(req);
  const row = findCaseByCode(code);
  if (!row || row.organization_id !== user.organization_id) return sendJson(res, 404, { success: false, error: 'Dosya bulunamadı.' });

  // Critical tenant-isolation check: the expert being assigned must belong
  // to the SAME organization as the case, or one company's admin could
  // hand another company's case to an outside expert.
  const expert = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'expert' AND organization_id = ?").get(expertId, user.organization_id);
  if (!expert) return sendJson(res, 400, { success: false, error: 'Geçersiz uzman.' });

  db.prepare("UPDATE cases SET expert_id = ?, status = 'Uzman İncelemesinde', updated_at = datetime('now') WHERE code = ?")
    .run(expert.id, code);
  audit(user.organization_id, code, user.name, `Dosya ${expert.name} adlı uzmana atandı.`);
  await sendEmail(expert.email, `Yeni Dosya Ataması (${code})`, `Size ${code} kodlu dosya inceleme için atandı.`);

  sendJson(res, 200, { success: true });
}

async function handleAdminApproveForBoard(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { code } = await readJsonBody(req);
  const row = findCaseByCode(code);
  if (!row || row.organization_id !== user.organization_id) return sendJson(res, 404, { success: false, error: 'Dosya bulunamadı.' });
  if (row.status !== 'YK Onayına Hazır') {
    return sendJson(res, 400, { success: false, error: 'Bu dosya henüz Yönetim Kurulu onayına hazır durumda değil.' });
  }
  db.prepare("UPDATE cases SET status = 'YK Onaylandı', updated_at = datetime('now') WHERE code = ?").run(code);
  audit(user.organization_id, code, user.name, 'Dosya Yönetim Kurulu Komuta Merkezine sunuldu.');
  await sendEmail(process.env.BOARD_EMAIL || 'board@kulaktan.local', `Karar Bekleyen Dosya (${code})`, `${code} kodlu dosya YK kararı için hazır.`);
  sendJson(res, 200, { success: true });
}

function handleAdminAudit(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  const rows = db.prepare('SELECT * FROM audit_log WHERE organization_id = ? ORDER BY id DESC LIMIT 200').all(user.organization_id);
  const chain = verifyAuditChain();
  sendJson(res, 200, { success: true, logs: rows, chainIntact: chain.intact });
}

function handleAdminEmails(req, res) {
  const user = requireRole(req, res, 'admin');
  if (!user) return;
  const rows = db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 200').all();
  sendJson(res, 200, { success: true, logs: rows });
}

// ---- expert (organization-scoped via expert_id, which is already org-bound) -

function handleExpertCases(req, res) {
  const user = requireRole(req, res, 'expert');
  if (!user) return;
  const rows = db.prepare(`
    SELECT cases.*, users.name as expert_name FROM cases
    LEFT JOIN users ON users.id = cases.expert_id
    WHERE cases.expert_id = ? AND cases.organization_id = ?
    ORDER BY cases.created_at DESC
  `).all(user.id, user.organization_id);
  sendJson(res, 200, { success: true, cases: rows.map((r) => caseToJson(r, { summary: true, opinion: true, messages: true })) });
}

async function handleExpertOpinion(req, res) {
  const user = requireRole(req, res, 'expert');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { code, opinion } = await readJsonBody(req);
  const row = findCaseByCode(code);
  if (!row || row.expert_id !== user.id || row.organization_id !== user.organization_id) {
    return sendJson(res, 404, { success: false, error: 'Dosya bulunamadı.' });
  }
  if (!opinion || !opinion.trim()) return sendJson(res, 400, { success: false, error: 'Mütalaa boş olamaz.' });

  db.prepare("UPDATE cases SET opinion_enc = ?, status = 'YK Onayına Hazır', updated_at = datetime('now') WHERE code = ?")
    .run(cr.encrypt(opinion), code);
  audit(user.organization_id, code, user.name, 'Uzman hukuki mütalaa sundu ve YK onayına sevk etti.');
  sendJson(res, 200, { success: true });
}

async function handleExpertMessage(req, res) {
  const user = requireRole(req, res, 'expert');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { code, text } = await readJsonBody(req);
  const row = findCaseByCode(code);
  if (!row || row.expert_id !== user.id || row.organization_id !== user.organization_id) {
    return sendJson(res, 404, { success: false, error: 'Dosya bulunamadı.' });
  }
  if (!text || !text.trim()) return sendJson(res, 400, { success: false, error: 'Mesaj boş olamaz.' });

  db.prepare('INSERT INTO messages (case_id, sender_role, text_enc) VALUES (?, ?, ?)').run(row.id, 'expert', cr.encrypt(text));
  sendJson(res, 200, { success: true });
}

function handleExpertAudit(req, res) {
  const user = requireRole(req, res, 'expert');
  if (!user) return;
  const rows = db.prepare(`
    SELECT audit_log.* FROM audit_log
    JOIN cases ON cases.code = audit_log.case_code
    WHERE cases.expert_id = ? AND cases.organization_id = ?
    ORDER BY audit_log.id DESC LIMIT 100
  `).all(user.id, user.organization_id);
  sendJson(res, 200, { success: true, logs: rows });
}

// ---- board (organization-scoped) ---------------------------------------------

function handleBoardCases(req, res) {
  const user = requireRole(req, res, 'board');
  if (!user) return;
  const rows = db.prepare(`
    SELECT cases.*, users.name as expert_name FROM cases
    LEFT JOIN users ON users.id = cases.expert_id
    WHERE cases.organization_id = ? AND cases.status IN ('YK Onaylandı', 'Dosya Kapatıldı / Arşivlendi')
    ORDER BY cases.created_at DESC
  `).all(user.organization_id);
  sendJson(res, 200, { success: true, cases: rows.map((r) => caseToJson(r, { opinion: true, decision: true })) });
}

async function handleBoardDecision(req, res) {
  const user = requireRole(req, res, 'board');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { code, decision } = await readJsonBody(req);
  const row = findCaseByCode(code);
  if (!row || row.organization_id !== user.organization_id) return sendJson(res, 404, { success: false, error: 'Dosya bulunamadı.' });
  if (!decision || !decision.trim()) {
    return sendJson(res, 400, { success: false, error: 'Yönetim kurulu kararı boş bırakılamaz.' });
  }
  db.prepare("UPDATE cases SET board_decision_enc = ?, status = 'Dosya Kapatıldı / Arşivlendi', updated_at = datetime('now') WHERE code = ?")
    .run(cr.encrypt(decision), code);
  audit(user.organization_id, code, user.name, 'Yönetim Kurulu kararı mühürlendi, dosya kapatıldı.');
  sendJson(res, 200, { success: true });
}

// ---- superadmin (platform operator, spans all organizations) ---------------

function handleSuperadminOrgs(req, res) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  const rows = db.prepare(`
    SELECT organizations.*,
      (SELECT COUNT(*) FROM cases WHERE cases.organization_id = organizations.id) as case_count,
      (SELECT COUNT(*) FROM users WHERE users.organization_id = organizations.id) as staff_count
    FROM organizations ORDER BY organizations.created_at DESC
  `).all();
  sendJson(res, 200, { success: true, organizations: rows.map(o => ({
    name: o.name, slug: o.slug, primaryColor: o.primary_color,
    caseCount: o.case_count, staffCount: o.staff_count, createdAt: o.created_at,
  })) });
}

async function handleSuperadminCreateOrg(req, res) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { name, slug, adminName, adminEmail } = await readJsonBody(req);
  if (!name || !slug || !adminName || !adminEmail) {
    return sendJson(res, 400, { success: false, error: 'Şirket adı, slug, admin adı ve admin e-postası gereklidir.' });
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return sendJson(res, 400, { success: false, error: 'Slug sadece küçük harf, rakam ve tire (-) içerebilir.' });
  }
  if (getOrgBySlug(slug)) {
    return sendJson(res, 400, { success: false, error: 'Bu slug zaten kullanılıyor.' });
  }

  const org = getOrCreateOrganization(name, slug);
  const adminUsername = `admin.${slug}`;
  const password = createStaffAccount(org.id, { role: 'admin', name: adminName, email: adminEmail, username: adminUsername });

  sendJson(res, 201, {
    success: true,
    organization: { name: org.name, slug: org.slug },
    admin: { username: adminUsername, password, email: adminEmail },
    message: 'Bu şifre bir daha gösterilmeyecek — şimdi kopyalayın.',
  });
}

async function handleSuperadminAddStaff(req, res, slug) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const org = getOrgBySlug(slug);
  if (!org) return sendJson(res, 404, { success: false, error: 'Organizasyon bulunamadı.' });

  const { role, name, email, username } = await readJsonBody(req);
  if (!['admin', 'expert', 'board'].includes(role)) {
    return sendJson(res, 400, { success: false, error: 'Geçersiz rol.' });
  }
  if (!name || !email || !username) {
    return sendJson(res, 400, { success: false, error: 'Ad, e-posta ve kullanıcı adı gereklidir.' });
  }

  const password = createStaffAccount(org.id, { role, name, email, username });
  if (password === null) {
    return sendJson(res, 400, { success: false, error: 'Bu kullanıcı adı zaten kullanılıyor.' });
  }
  sendJson(res, 201, { success: true, username, password, message: 'Bu şifre bir daha gösterilmeyecek — şimdi kopyalayın.' });
}

async function handleSuperadminBranding(req, res, slug) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const org = getOrgBySlug(slug);
  if (!org) return sendJson(res, 404, { success: false, error: 'Organizasyon bulunamadı.' });

  const { primaryColor } = await readJsonBody(req);
  try {
    updateOrgBranding(org.id, primaryColor);
  } catch (err) {
    return sendJson(res, 400, { success: false, error: err.message });
  }
  sendJson(res, 200, { success: true });
}

function handleSuperadminListStaff(req, res, slug) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;

  const org = getOrgBySlug(slug);
  if (!org) return sendJson(res, 404, { success: false, error: 'Organizasyon bulunamadı.' });

  const staff = listStaffForOrg(org.id);
  sendJson(res, 200, { success: true, staff });
}

async function handleSuperadminUpdateStaff(req, res, userId) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  const { name, email, role } = await readJsonBody(req);
  if (!name || !email || !role) {
    return sendJson(res, 400, { success: false, error: 'Ad, e-posta ve rol gereklidir.' });
  }
  try {
    updateStaffAccount(Number(userId), { name, email, role });
  } catch (err) {
    return sendJson(res, 400, { success: false, error: err.message });
  }
  sendJson(res, 200, { success: true });
}

async function handleSuperadminDeleteStaff(req, res, userId) {
  const user = requireRole(req, res, 'superadmin');
  if (!user) return;
  if (!requireCsrf(req, res, user)) return;

  try {
    deleteStaffAccount(Number(userId));
  } catch (err) {
    return sendJson(res, 400, { success: false, error: err.message });
  }
  sendJson(res, 200, { success: true });
}

// ---- router ------------------------------------------------------------------

const CLEAN_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.html': 'app.html',
  '/takip': 'takip.html',
  '/takip.html': 'takip.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/uzman': 'uzman.html',
  '/uzman.html': 'uzman.html',
  '/board': 'board.html',
  '/board.html': 'board.html',
  '/superadmin': 'superadmin.html',
  '/superadmin.html': 'superadmin.html',
  '/reset-password.html': 'reset-password.html',
};

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    // ---- multi-tenant public routes: /o/<slug> and /o/<slug>/takip ----
    const orgMatch = p.match(/^\/o\/([a-z0-9-]+)(\/takip)?\/?$/);
    if (orgMatch && m === 'GET') {
      const file = orgMatch[2] ? 'takip.html' : 'index.html';
      return serveStatic(res, path.join(PUBLIC_DIR, file));
    }
    if (p.match(/^\/api\/orgs\/[a-z0-9-]+$/) && m === 'GET') {
      return handleOrgPublicInfo(req, res, p.split('/').pop());
    }

    // ---- API ----
    if (p === '/api/cases' && m === 'POST') return await handleSubmitCase(req, res);
    if (p === '/api/cases/track' && m === 'GET') return await handleTrackCase(req, res, url.searchParams);
    if (p === '/api/cases/message' && m === 'POST') return await handleWhistleblowerMessage(req, res);

    if (p === '/api/auth/login' && m === 'POST') return await handleLogin(req, res);
    if (p === '/api/auth/logout' && m === 'POST') return handleLogout(req, res);
    if (p === '/api/auth/me' && m === 'GET') return handleMe(req, res);
    if (p === '/api/auth/request-reset' && m === 'POST') return await handleRequestReset(req, res);
    if (p === '/api/auth/reset-password' && m === 'POST') return await handleResetPassword(req, res);
    if (p === '/api/contact' && m === 'POST') return await handleContactForm(req, res);

    if (p === '/api/admin/cases' && m === 'GET') return handleAdminCases(req, res);
    if (p === '/api/admin/experts' && m === 'GET') return handleAdminExperts(req, res);
    if (p === '/api/admin/assign' && m === 'POST') return await handleAdminAssign(req, res);
    if (p === '/api/admin/approve-for-board' && m === 'POST') return await handleAdminApproveForBoard(req, res);
    if (p === '/api/admin/audit' && m === 'GET') return handleAdminAudit(req, res);
    if (p === '/api/admin/emails' && m === 'GET') return handleAdminEmails(req, res);

    if (p === '/api/expert/cases' && m === 'GET') return handleExpertCases(req, res);
    if (p === '/api/expert/opinion' && m === 'POST') return await handleExpertOpinion(req, res);
    if (p === '/api/expert/message' && m === 'POST') return await handleExpertMessage(req, res);
    if (p === '/api/expert/audit' && m === 'GET') return handleExpertAudit(req, res);

    if (p === '/api/board/cases' && m === 'GET') return handleBoardCases(req, res);
    if (p === '/api/board/decision' && m === 'POST') return await handleBoardDecision(req, res);

    if (p === '/api/superadmin/organizations' && m === 'GET') return handleSuperadminOrgs(req, res);
    if (p === '/api/superadmin/organizations' && m === 'POST') return await handleSuperadminCreateOrg(req, res);
    const staffMatch = p.match(/^\/api\/superadmin\/organizations\/([a-z0-9-]+)\/staff$/);
    if (staffMatch && m === 'POST') return await handleSuperadminAddStaff(req, res, staffMatch[1]);
    const brandingMatch = p.match(/^\/api\/superadmin\/organizations\/([a-z0-9-]+)\/branding$/);
    if (brandingMatch && m === 'POST') return await handleSuperadminBranding(req, res, brandingMatch[1]);
    const listStaffMatch = p.match(/^\/api\/superadmin\/organizations\/([a-z0-9-]+)\/staff$/);
    if (listStaffMatch && m === 'GET') return handleSuperadminListStaff(req, res, listStaffMatch[1]);
    const updateStaffMatch = p.match(/^\/api\/superadmin\/staff\/(\d+)$/);
    if (updateStaffMatch && m === 'PUT') return await handleSuperadminUpdateStaff(req, res, updateStaffMatch[1]);
    if (updateStaffMatch && m === 'DELETE') return await handleSuperadminDeleteStaff(req, res, updateStaffMatch[1]);

    // ---- static / pages ----
    if (m === 'GET') {
      if (CLEAN_ROUTES[p]) return serveStatic(res, path.join(PUBLIC_DIR, CLEAN_ROUTES[p]));
      const safePath = path.normalize(path.join(PUBLIC_DIR, p));
      if (safePath.startsWith(PUBLIC_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        return serveStatic(res, safePath);
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadı.');
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      return sendJson(res, 413, { success: false, error: 'Gönderilen veri çok büyük.' });
    }
    if (err && err.message && err.message.includes('KULAKTAN_MASTER_KEY')) {
      console.error(err.message);
      return sendJson(res, 500, { success: false, error: 'Sunucu yapılandırma hatası: şifreleme anahtarı tanımlı değil.' });
    }
    console.error(err);
    sendJson(res, 500, { success: false, error: 'Sunucu hatası.' });
  }
});

server.listen(PORT, () => {
  console.log(`Kulaktan sunucusu http://localhost:${PORT} adresinde çalışıyor.`);
});

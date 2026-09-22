// lib/org-helpers.js
'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { hashPassword } = require('./crypto');

function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function getOrCreateOrganization(name, slug) {
  let org = db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug);
  if (org) return org;
  const result = db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)').run(name, slug);
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(result.lastInsertRowid);
}

// Creates one staff account if it doesn't already exist. Pass orgId as null
// for a superadmin account (not tied to any single organization).
// Returns the generated password (or null if the account already existed).
function createStaffAccount(orgId, { role, name, email, username }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return null;
  const password = randomPassword();
  const password_hash = hashPassword(password);
  db.prepare('INSERT INTO users (organization_id, role, name, email, username, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orgId, role, name, email, username, password_hash);
  return password;
}

function updateOrgBranding(orgId, primaryColor) {
  if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
    throw new Error('Geçersiz renk kodu. Örnek: #0f172a');
  }
  db.prepare('UPDATE organizations SET primary_color = ? WHERE id = ?').run(primaryColor, orgId);
}

function listStaffForOrg(orgId) {
  return db.prepare('SELECT id, role, name, email, username, created_at FROM users WHERE organization_id = ? ORDER BY role, name').all(orgId);
}

// Throws with a user-facing message on failure; returns nothing on success.
function updateStaffAccount(userId, { name, email, role }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Kullanıcı bulunamadı.');
  if (user.role === 'superadmin') throw new Error('Süper-admin hesapları bu ekrandan düzenlenemez.');
  if (!['admin', 'expert', 'board'].includes(role)) throw new Error('Geçersiz rol.');

  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (emailTaken) throw new Error('Bu e-posta başka bir hesapta kullanılıyor.');

  db.prepare('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?').run(name, email, role, userId);
}

// Throws with a user-facing message if deletion isn't safe; returns nothing on success.
function deleteStaffAccount(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Kullanıcı bulunamadı.');
  if (user.role === 'superadmin') throw new Error('Süper-admin hesapları bu ekrandan silinemez.');

  if (user.role === 'expert') {
    const openCases = db.prepare(`
      SELECT COUNT(*) as n FROM cases
      WHERE expert_id = ? AND status NOT IN ('Dosya Kapatıldı / Arşivlendi')
    `).get(userId);
    if (openCases.n > 0) {
      throw new Error(`Bu uzmana atanmış ${openCases.n} açık dosya var. Silmeden önce dosyaları başka bir uzmana yeniden atayın.`);
    }
  }

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

module.exports = {
  getOrCreateOrganization, createStaffAccount, randomPassword, updateOrgBranding,
  listStaffForOrg, updateStaffAccount, deleteStaffAccount,
};

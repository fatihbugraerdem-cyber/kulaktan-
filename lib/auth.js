// lib/auth.js
'use strict';
const db = require('./db');
const { hashToken, randomToken } = require('./crypto');
const { parseCookies, setCookie, sendJson } = require('./http-utils');

const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const COOKIE_NAME = 'kulaktan_session';
const CSRF_COOKIE_NAME = 'kulaktan_csrf';

function createSession(res, user) {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, role, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash, user.id, user.role, csrfToken, expiresAt);
  setCookie(res, COOKIE_NAME, token, { maxAge: SESSION_TTL_SECONDS, httpOnly: true });
  // CSRF cookie is deliberately NOT httpOnly — the frontend JS needs to read
  // it and echo it back in a custom header (double-submit pattern).
  setCookie(res, CSRF_COOKIE_NAME, csrfToken, { maxAge: SESSION_TTL_SECONDS, httpOnly: false });
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT users.id as id, users.role as role, users.name as name, users.email as email,
           users.organization_id as organization_id,
           sessions.expires_at as expires_at, sessions.csrf_token as csrf_token
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

// Returns the user if authorized for `role`, otherwise writes a 401 and returns null.
function requireRole(req, res, role) {
  const user = getSessionUser(req);
  if (!user || user.role !== role) {
    sendJson(res, 401, { success: false, error: 'Yetkisiz erişim. Lütfen giriş yapın.' });
    return null;
  }
  return user;
}

// Call for every state-changing (POST/PUT/DELETE) request made by an
// authenticated session. Public, unauthenticated endpoints (case submission,
// whistleblower tracking) don't need this — there's no session/cookie
// privilege for a forged cross-site request to ride on there.
function requireCsrf(req, res, user) {
  const header = req.headers['x-csrf-token'];
  if (!header || header !== user.csrf_token) {
    sendJson(res, 403, { success: false, error: 'Geçersiz CSRF token. Sayfayı yenileyip tekrar deneyin.' });
    return false;
  }
  return true;
}

function destroySession(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  setCookie(res, COOKIE_NAME, '', { maxAge: 0 });
  setCookie(res, CSRF_COOKIE_NAME, '', { maxAge: 0, httpOnly: false });
}

// Deletes every session for a user — used on password reset so a stolen
// session can't survive a credential change.
function destroyAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

module.exports = { createSession, getSessionUser, requireRole, requireCsrf, destroySession, destroyAllSessionsForUser };

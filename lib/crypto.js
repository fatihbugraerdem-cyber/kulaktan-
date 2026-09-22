// lib/crypto.js
// All real cryptography for Kulaktan. No external dependencies —
// everything here is Node.js's built-in `crypto` module.
'use strict';
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';

function getMasterKey() {
  const b64 = process.env.KULAKTAN_MASTER_KEY;
  if (!b64) {
    throw new Error(
      'KULAKTAN_MASTER_KEY ortam değişkeni tanımlı değil. .env.example dosyasına bakıp ' +
      '`node lib/gen-key.js` ile bir anahtar üretip .env dosyanıza ekleyin.'
    );
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('KULAKTAN_MASTER_KEY 32 byte olmalı (base64 ile ~44 karakter). `node lib/gen-key.js` ile doğru formatta üretin.');
  }
  return key;
}

// Encrypts a UTF-8 string. Output: base64(iv[12] + authTag[16] + ciphertext).
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payloadB64) {
  if (!payloadB64) return null;
  const key = getMasterKey();
  const buf = Buffer.from(payloadB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// Encrypts raw binary (for evidence files). Output: base64(iv+tag+ciphertext).
function encryptBuffer(buffer) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptBuffer(payloadB64) {
  const key = getMasterKey();
  const buf = Buffer.from(payloadB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const test = crypto.scryptSync(password, salt, 64);
  return hash.length === test.length && crypto.timingSafeEqual(hash, test);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function genCaseCode() {
  const year = new Date().getFullYear();
  const num = Math.floor(1000 + Math.random() * 9000);
  return `KLT-${year}-${num}`;
}

// Tamper-evident audit chain: each entry's hash depends on the previous
// entry's hash plus its own content. If any historical row is edited, every
// hash after it stops matching — this makes silent tampering detectable
// (not physically impossible — a DB admin could still edit rows and
// recompute the chain forward — but any *undetected* edit is now much
// harder, and casual/accidental tampering is caught immediately).
function computeAuditHash(prevHash, entry) {
  const payload = `${prevHash || 'GENESIS'}|${entry.organization_id}|${entry.case_code}|${entry.actor}|${entry.action}|${entry.created_at}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = {
  encrypt, decrypt, encryptBuffer, decryptBuffer,
  hashPassword, verifyPassword, hashToken, randomToken, genCaseCode,
  computeAuditHash,
};

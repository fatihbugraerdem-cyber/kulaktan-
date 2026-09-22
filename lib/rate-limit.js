// lib/rate-limit.js
// A simple in-memory sliding-window rate limiter. Good enough for a single
// server process. If you later run multiple instances behind a load
// balancer, replace the Map below with a shared store (Redis, etc.) — the
// function signatures here are intentionally small so that's a localized change.
'use strict';

const buckets = new Map(); // key -> { count, windowStart }

// Periodically clear stale buckets so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now - b.windowStart > 60 * 60 * 1000) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * Returns { allowed, remaining, retryAfterMs }.
 * @param {string} key - unique bucket key, e.g. `login:${ip}:${username}`
 * @param {number} max - max requests allowed in the window
 * @param {number} windowMs - window size in milliseconds
 */
function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count++;
  const allowed = bucket.count <= max;
  const retryAfterMs = allowed ? 0 : windowMs - (now - bucket.windowStart);
  return { allowed, remaining: Math.max(0, max - bucket.count), retryAfterMs };
}

function clientIp(req) {
  // Trust X-Forwarded-For only if you know your deployment sits behind a
  // reverse proxy that sets it (nginx, Render, Railway, etc.) — otherwise
  // this header can be spoofed by the client itself.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

module.exports = { checkRateLimit, clientIp };

// Run with: node lib/gen-key.js
// Prints a fresh, valid KULAKTAN_MASTER_KEY value.
const crypto = require('node:crypto');
console.log(crypto.randomBytes(32).toString('base64'));

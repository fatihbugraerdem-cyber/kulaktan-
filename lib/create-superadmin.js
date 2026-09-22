// Run with: node --env-file=.env lib/create-superadmin.js "Adınız Soyadınız" superadminuser you@yourcompany.com
// Creates a platform-operator account (not tied to any customer organization)
// that can manage all organizations from /superadmin.html.
'use strict';
const { createStaffAccount } = require('./org-helpers');

const [, , name, username, email] = process.argv;
if (!name || !username || !email) {
  console.error('Kullanım: node --env-file=.env lib/create-superadmin.js "Ad Soyad" kullanici.adi email@adres.com');
  process.exit(1);
}

const password = createStaffAccount(null, { role: 'superadmin', name, email, username });
if (password === null) {
  console.error(`Hata: "${username}" kullanıcı adı zaten kullanılıyor.`);
  process.exit(1);
}

console.log(`SUPERADMIN | kullanıcı adı: ${username} | şifre: ${password}`);
console.log('--- Bu şifreyi güvenli bir yere kaydedin, bir daha gösterilmeyecek. ---');
console.log('Giriş: /superadmin.html');

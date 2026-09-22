// Run with: node --env-file=.env lib/add-staff.js acme expert "Av. Zeynep Kaya" zeynep.kaya zeynep@acme.com
'use strict';
const db = require('./db');
const { createStaffAccount } = require('./org-helpers');

const [, , slug, role, name, username, email] = process.argv;
if (!slug || !role || !name || !username || !email) {
  console.error('Kullanım: node --env-file=.env lib/add-staff.js <org-slug> <admin|expert|board> "<Ad Soyad>" <kullanici.adi> <email>');
  process.exit(1);
}
if (!['admin', 'expert', 'board'].includes(role)) {
  console.error('Hata: rol admin, expert veya board olmalı.');
  process.exit(1);
}

const org = db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug);
if (!org) {
  console.error(`Hata: "${slug}" slug'ına sahip bir organizasyon bulunamadı. Önce lib/create-org.js ile oluşturun.`);
  process.exit(1);
}

const password = createStaffAccount(org.id, { role, name, email, username });
if (password === null) {
  console.error(`Hata: "${username}" kullanıcı adı zaten kullanılıyor.`);
  process.exit(1);
}

console.log(`${role.toUpperCase()} | ${org.name} | kullanıcı adı: ${username} | şifre: ${password}`);
console.log('--- Bu şifreyi güvenli bir yere kaydedin, bir daha gösterilmeyecek. ---');

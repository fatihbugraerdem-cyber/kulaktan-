// Run with: node --env-file=.env lib/seed.js
// Creates a demo/default organization and its admin/expert/board accounts.
// For onboarding a real customer company on the SaaS platform, use
// lib/create-org.js instead.
'use strict';
const { getOrCreateOrganization, createStaffAccount } = require('./org-helpers');

const org = getOrCreateOrganization('Varsayılan Şirket (Demo)', 'default');
console.log(`--- Organizasyon: ${org.name} (slug: ${org.slug}) ---`);

const seedUsers = [
  { role: 'admin', name: 'Sistem Yöneticisi', email: 'admin@kulaktan.local', username: 'admin' },
  { role: 'expert', name: 'Prof. Dr. Ahmet Yılmaz', email: 'ahmet.yilmaz@kulaktan.local', username: 'ahmet.yilmaz' },
  { role: 'expert', name: 'Av. Dr. Selin Demir', email: 'selin.demir@kulaktan.local', username: 'selin.demir' },
  { role: 'board', name: 'Yönetim Kurulu Üyesi', email: 'board@kulaktan.local', username: 'board' },
];

console.log('--- Kulaktan: hesaplar oluşturuluyor ---');
for (const u of seedUsers) {
  const password = createStaffAccount(org.id, u);
  if (password === null) {
    console.log(`(zaten mevcut, atlandı) ${u.role} / ${u.username}`);
    continue;
  }
  console.log(`${u.role.toUpperCase().padEnd(7)} | kullanıcı adı: ${u.username.padEnd(16)} | şifre: ${password}`);
}
console.log('--- Bu şifreleri güvenli bir yere kaydedin: bir daha bu şekilde gösterilmeyecek. ---');
console.log(`--- Demo ihbar formu: http://localhost:3000/o/${org.slug} ---`);

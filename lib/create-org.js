// Run with: node --env-file=.env lib/create-org.js "Acme Sanayi A.Ş." acme
// Creates a new customer organization plus its first admin account.
// Add more staff (expert/board) accounts with lib/add-staff.js.
'use strict';
const { getOrCreateOrganization, createStaffAccount } = require('./org-helpers');

const [, , name, slug] = process.argv;
if (!name || !slug) {
  console.error('Kullanım: node --env-file=.env lib/create-org.js "Şirket Adı" sirket-slug');
  console.error('  slug: URL\'de kullanılacak kısa ad, örn. "acme" -> /o/acme');
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error('Hata: slug sadece küçük harf, rakam ve tire (-) içerebilir.');
  process.exit(1);
}

const org = getOrCreateOrganization(name, slug);
console.log(`--- Organizasyon hazır: ${org.name} (slug: ${org.slug}) ---`);
console.log(`--- İhbar formu adresi: /o/${org.slug} ---`);

const adminUsername = `admin.${slug}`;
const password = createStaffAccount(org.id, {
  role: 'admin',
  name: `${name} Yöneticisi`,
  email: `admin@${slug}.kulaktan.local`,
  username: adminUsername,
});

if (password === null) {
  console.log(`(zaten mevcut) admin hesabı: ${adminUsername}`);
} else {
  console.log(`ADMIN | kullanıcı adı: ${adminUsername} | şifre: ${password}`);
  console.log('--- Bu şifreyi güvenli bir yere kaydedin, bir daha gösterilmeyecek. ---');
}
console.log('Uzman/YK hesapları eklemek için lib/add-staff.js kullanın.');

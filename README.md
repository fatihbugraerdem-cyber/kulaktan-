# Kulaktan

Kurumsal anonim ihbar (whistleblowing) ve uyum yönetim platformu. Birden fazla
müşteri şirkete hizmet verebilen (multi-tenant) bir SaaS olarak çalışır.

## Bu sürümde ne değişti (v2 — güvenlik sertleştirme + çoklu şirket)

- **Çoklu şirket (multi-tenant) izolasyonu**: Her müşteri şirket kendi
  `organization`'ına sahip. Bir şirketin admin/uzman/YK hesabı **yapısal olarak**
  başka bir şirketin verisini göremez veya değiştiremez — her sorgu
  `organization_id` ile filtrelenir. Bu, gerçek saldırı senaryolarıyla test
  edilmiştir (bkz. "Test" bölümü).
- **CSRF koruması**: Admin/uzman/YK panellerindeki tüm durum-değiştiren
  işlemler (atama, mütalaa, karar) çift-gönderim (double-submit) CSRF token'ı
  gerektirir.
- **Rate limiting + hesap kilitleme**: Giriş denemeleri, ihbar gönderimi ve
  mesajlaşma uç noktaları IP bazlı hız sınırlamasıyla korunur. 5 başarısız
  girişten sonra hesap 15 dakika kilitlenir.
- **Şifre sıfırlama akışı**: Artık gerçek bir "şifremi unuttum" akışı var
  (tek kullanımlık, 30 dakika geçerli token; sıfırlama sırasında tüm oturumlar
  sonlandırılır).
- **Denetim izinde hash-zinciri (tamper-evidence)**: Her denetim kaydı bir
  önceki kaydın hash'ini içerir. Geçmişte bir kayıt değiştirilirse (veritabanına
  doğrudan müdahale edilse bile), admin panelindeki "Zincir Bütünlüğü" rozeti
  bunu tespit eder. (Not: Bu, kayıtları *tespit edilmeden* değiştirmeyi çok
  zorlaştırır; veritabanına tam erişimi olan biri zinciri baştan yeniden
  hesaplayabilir — gerçek "değiştirilemezlik" için harici bir günlük/imza
  sunucusuna anchor'lamak gerekir, bu v3 için bir öneri.)
- **Güvenlik header'ları**: CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy her yanıtta gönderiliyor.
- **Kanıt dosyası MIME allow-list**: Sadece PDF/Word/Excel/resim/metin türleri
  kabul ediliyor.

Önceki (v1) sürümde neyin değiştiğine dair özet için Git geçmişine veya proje
notlarına bakın — kısaca: statik localStorage tabanlı 6 HTML dosyasından
gerçek şifreli, çok kullanıcılı bir arka uca geçiş yapılmıştı.

## Hızlı başlangıç

```bash
# 1. Node.js 22.5+ gerekli (node:sqlite modülü için)
node --version

# 2. Şifreleme anahtarı üret
node lib/gen-key.js

# 3. .env dosyasını oluştur
cp .env.example .env
# .env içine KULAKTAN_MASTER_KEY=<üretilen anahtar> yaz

# 4. Varsayılan/demo organizasyonu ve hesapları oluştur
node --env-file=.env lib/seed.js
# çıktıdaki kullanıcı adı/şifreleri kaydet

# 5. Sunucuyu başlat
node --env-file=.env server.js
# http://localhost:3000  (demo ihbar formu: http://localhost:3000/o/default)
```

`npm install` gerekmez — proje hiçbir npm paketine bağlı değil (bkz. altta
"Neden sıfır bağımlılık?").

## Çoklu şirket (multi-tenant) — yeni müşteri nasıl eklenir?

**Web arayüzünden (önerilen — v3 ile eklendi):**

```bash
# İlk süper-admin hesabınızı oluşturun (bir kez)
node --env-file=.env lib/create-superadmin.js "Adınız Soyadınız" kullaniciadi email@sirket.com
```

Sonra `/superadmin.html` adresinden giriş yapıp web arayüzünden:
- Yeni şirket ekleyebilir (adı, slug, ilk admin bilgileri),
- Mevcut bir şirkete uzman/YK/admin personeli ekleyebilir,
- Şirketin ihbar formundaki **marka rengini** değiştirebilirsiniz.

**CLI'dan (hâlâ çalışır, script/otomasyon için kullanışlı):**

```bash
node --env-file=.env lib/create-org.js "Acme Sanayi A.Ş." acme
node --env-file=.env lib/add-staff.js acme expert "Av. Zeynep Kaya" zeynep.kaya zeynep@acme.com
```

Her şirketin kendi ihbar formu `https://sizin-domaininiz.com/o/<slug>`
adresinde yaşar (ör. `/o/acme`). Bu linki o şirketin çalışanlarına
dağıtırsınız — her biri kendi kurumsal kimliğini (şirket adı + marka rengi)
görür ve gönderdikleri ihbarlar sadece o şirketin admin/uzman/YK hesaplarına
görünür.

Admin/uzman/YK girişleri (`/admin`, `/uzman`, `/board`) tek bir ortak giriş
sayfası — hangi şirkete ait oldukları, giriş yaptıklarında hesaplarına bağlı
`organization_id` ile otomatik belirlenir, ayrı bir URL'e gerek yoktur.

**Şu an eksik olan**: Şirket başına logo yükleme (şu an sadece vurgu rengi
özelleştirilebiliyor) ve özel alan adı (custom domain) desteği. Marka rengi
şu an sadece halka açık ihbar formunda (`/o/<slug>`) uygulanıyor; admin/uzman/
YK panelleri hâlâ ortak "Kulaktan" görünümünü kullanıyor (bu bilinçli bir
tercih — dahili personel panelleri için marka tutarlılığından çok işlevsellik
önceliklendirildi, ama istenirse aynı mekanizma oraya da taşınabilir).

## Neden sıfır bağımlılık (no npm packages)?

Bu ortamda paket kaydına (npm registry) ağ erişimi olmadığı için `express`,
`bcrypt`, `sqlite3` gibi yaygın paketleri kuramadım. Bunun yerine tamamen
Node.js'in kendi çekirdek modülleriyle (`http`, `node:sqlite`, `crypto`, yerleşik
`fetch`) gerçek, çalışan bir arka uç yazdım. Bunun sizin için de gerçek bir
avantajı var: sunucunuzda `npm install` çalıştırmanıza gerek yok, tedarik
zinciri (supply-chain) riski taşıyan üçüncü parti bağımlılık yok, sadece
Node.js 22+ kurulu olan her yerde çalışır.

`node:sqlite` şu an Node'da "deneysel" (experimental) olarak işaretli — kod
çalışırken bir uyarı basar, bu normaldir ve işlevi etkilemez.

## Mimari

```
kulaktan/
├── server.js              Ana HTTP sunucusu, tüm route'lar, güvenlik header'ları
├── lib/
│   ├── db.js               SQLite şeması (organizations, users, cases, ...)
│   ├── crypto.js            AES-256-GCM şifreleme, şifre hash'leme, hash-zinciri
│   ├── auth.js               Oturum + CSRF token yönetimi
│   ├── rate-limit.js          Bellek-içi hız sınırlama (bkz. "Bilinen sınırlar")
│   ├── email.js               Resend API ile e-posta / konsola loglama
│   ├── org-helpers.js          Organizasyon, personel, marka rengi yardımcıları
│   ├── seed.js                 Demo organizasyon + hesapları oluşturur
│   ├── create-org.js            Yeni müşteri şirket ekleme CLI'ı
│   ├── add-staff.js              Mevcut şirkete uzman/YK/admin ekleme CLI'ı
│   ├── create-superadmin.js       İlk platform-yönetici hesabını oluşturur
│   └── gen-key.js                  Şifreleme anahtarı üretici
├── public/                  Tüm HTML sayfaları
│   ├── assets/
│   │   ├── logo-icon.png      Kırpılmış ikon (header'larda kullanılır)
│   │   ├── logo-full.png       Tam logo (ikon + yazı)
│   │   ├── hero-visual.jpg      Ana sayfa hero görseli
│   │   ├── og-image.jpg          Sosyal paylaşım (Open Graph) görseli
│   │   ├── founder-fatih.jpg      Kurucu fotoğrafı (İletişim sayfası)
│   │   └── kulaktan.css            Ortak tasarım sistemi
│   ├── favicon-16.png / favicon-32.png / apple-touch-icon.png
│   ├── sitemap.xml / robots.txt      Arama motorları için
│   ├── index.html            İhbar formu (bkz. /o/<slug> route'u, marka rengi)
│   ├── takip.html             İhbarcı durum takibi + mesajlaşma
│   ├── admin.html              Admin paneli (atama, denetim izi, e-posta logu)
│   ├── uzman.html               Uzman paneli
│   ├── board.html                 Yönetim Kurulu paneli
│   ├── superadmin.html             Platform yönetimi: şirket/personel/marka
│   ├── neden-kulaktan.html          Hukuki çerçeve, ISO 37002, istatistikler
│   ├── nasil-calisir.html            Detaylı iş akışı / soruşturma süreci
│   ├── fiyatlandirma.html             Fiyatlandırma modeli
│   ├── sss.html                        Sıkça Sorulan Sorular
│   ├── iletisim.html                   İletişim formu (gerçek backend'e bağlı)
│   ├── kvkk.html                        KVKK Aydınlatma Metni (şablon, doldurulmalı)
│   ├── kullanim-sartlari.html            Kullanım Şartları (şablon, doldurulmalı)
│   ├── guvenlik.html                      Güvenlik Bilgilendirmesi
│   ├── reset-password.html                 Şifre sıfırlama sayfası
│   └── app.html                             Eski forma yönlendirme
├── data/kulaktan.db          SQLite veritabanı dosyası
├── render.yaml                Render Blueprint (bkz. "Dağıtım" bölümü)
├── .gitignore
└── .env                       Ortam değişkenleri (.env.example'a bakın)
```

### Roller, akış ve tenant izolasyonu

0. **Süper-admin** (`superadmin.html`, organizasyona bağlı değil) yeni müşteri
   şirketler oluşturur, personel ekler, marka rengini ayarlar. Platform
   işletmecisinin (sizin) rolüdür — müşteri şirketlerin kendileri bu role
   erişemez.
1. **İhbarcı**, `/o/<slug>` adresinden (veya slug verilmezse "default"
   organizasyonuna) anonim bir rapor gönderir → bir **dosya kodu** ve bir
   **erişim anahtarı** alır.
2. **Admin** (kendi organizasyonuna ait oturum) SADECE kendi şirketinin
   dosyalarını görür, SADECE kendi şirketinin uzmanlarına atayabilir.
3. **Uzman** kendisine atanan (ve kendi organizasyonuna ait) dosyaları görür.
4. **Yönetim Kurulu** kendi organizasyonunun onaylanmış dosyalarını görür ve
   karar verir.
5. **İhbarcı**, kod + erişim anahtarı ile süreci baştan sona takip eder.

Her admin/expert/board API çağrısı, oturumdaki kullanıcının
`organization_id`'siyle otomatik filtrelenir — bu kontrol atlanamaz çünkü
sorgunun kendisinin bir parçasıdır (bkz. `server.js` içindeki `WHERE
organization_id = ?` kullanımları). Süper-admin uç noktaları ayrı bir
`requireRole(..., 'superadmin')` kontrolüyle korunur; normal bir admin
hesabıyla bu uç noktalara erişim denenirse 401 döner (test edilmiştir).

## Güvenlik modeli (özet)

- **Şifreleme**: AES-256-GCM, tek bir sunucu-taraflı ana anahtarla (uçtan uca/
  zero-knowledge değil — admin/uzman/YK'nın raporu okuyabilmesi gerekiyor).
- **Şifreler**: scrypt ile hash'lenir, düz metin hiçbir yerde saklanmaz.
- **Oturumlar**: rastgele 32-byte token, httpOnly çerez, 8 saat TTL.
- **CSRF**: çift-gönderim deseni (httpOnly olmayan ayrı bir çerez + özel header).
- **Hız sınırlama**: giriş (IP+kullanıcı bazlı), ihbar gönderimi, mesajlaşma.
- **Hesap kilitleme**: 5 başarısız girişten sonra 15 dakika.
- **Şifre sıfırlama**: tek kullanımlık, 30 dakika geçerli, tüm oturumları sonlandırır.
- **Denetim izi**: hash-zincirlenmiş, müdahale tespit edilebilir.
- **Dosya yükleme**: MIME allow-list + 15MB sınırı.
- **HTTP güvenlik header'ları**: CSP, X-Frame-Options, vb.

## Bilinen sınırlar (v3 için notlar)

- **Rate limiting bellek-içi**: Tek sunucu process'i için çalışır. Birden
  fazla sunucu instance'ı (yatay ölçekleme) çalıştırırsanız paylaşımlı bir
  store'a (Redis vb.) geçmeniz gerekir — `lib/rate-limit.js` bunun için
  izole edilmiş, değiştirmesi kolay.
- **Audit hash-zinciri, harici anchor'lama yok**: Veritabanına tam erişimi
  olan biri (ör. bir sunucu yöneticisi) zinciri baştan yeniden hesaplayarak
  tutarlı hale getirebilir. Gerçek "immutable" denetim izi için zinciri
  periyodik olarak harici, salt-okunur bir yere (ör. imzalı bir log servisi
  veya blockchain benzeri bir anchor) yazmak gerekir.
- **Süper-admin arayüzü**: Şirket/personel/marka rengi yönetimi ve personel
  düzenleme/silme mümkün (güvenlik kontrolleriyle: açık dosyası olan bir uzman
  silinemez, süper-admin hesapları bu ekrandan değiştirilemez). Henüz olmayan:
  şirket silme, kullanım istatistikleri, toplu işlemler.
- **Şirket başına özelleştirme sadece renk**: Logo yükleme, tam tema
  özelleştirmesi ve özel alan adı (custom domain) henüz yok. Marka rengi şu an
  sadece halka açık ihbar formuna (`/o/<slug>`) uygulanıyor, dahili admin/uzman/
  YK panellerine değil.
- **Rate limiting, `X-Forwarded-For` header'ına güveniyor**: Bu, SADECE
  güvendiğiniz bir ters proxy'nin (nginx, Caddy, Railway/Render'ın kendi proxy'si)
  arkasında çalışırken güvenlidir — çünkü o zaman header'ı proxy kendi üzerine
  yazar. Uygulamayı bir ters proxy OLMADAN doğrudan internete açarsanız, bu
  header sahtelenebilir ve rate limiting/hesap kilitleme atlatılabilir. README'deki
  dağıtım talimatları zaten bir ters proxy kullanmanızı varsayıyor.
- **Kanıt dosyası yükleme** hâlâ base64/JSON üzerinden (gerçek
  `multipart/form-data` değil) — küçük/orta dosyalar için sorunsuz.
- **Tek SQLite dosyası**: Çok yüksek trafik senaryosunda Postgres'e geçmek
  gerekir (tüm sorgular `lib/db.js` üzerinden geçtiği için bu değişiklik
  izole ve nispeten kolaydır).
- **CSP, Tailwind Play CDN ve Lucide CDN'e izin veriyor**: `index.html`
  bu iki üçüncü parti script'e bağımlı olduğu için CSP onları beyaz listeye
  aldı. Bu, o CDN'lerin ele geçirilmesi ihtimaline karşı küçük bir tedarik
  zinciri riski taşır. Uzun vadede bunları pinned/self-hosted bir derlemeyle
  değiştirmek bu riski tamamen ortadan kaldırır.

## Marka varlıkları (logo)

Yüklediğiniz logodan otomatik olarak üretildi:
- `public/assets/logo-icon.png` — sadece ikon (kare, header'larda ve favicon'da kullanılıyor)
- `public/assets/logo-full.png` — tam logo (ikon + "kulaktan" yazısı)
- `public/favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`

Logoyu değiştirmek isterseniz, yeni dosyayı `public/assets/` altına aynı
dosya adlarıyla koymanız yeterli — HTML dosyalarını değiştirmenize gerek yok.
İkon dosyasının **kare ve düz beyaz arka planlı** olması, koyu renkli
header'larda (admin/board panelleri) kullanılan beyaz "chip" sarmalayıcıyla
uyumlu görünmesi için önerilir.

## Tasarım sistemi

Site, uluslararası hukuk bürolarının (Linklaters, Addleshaw Goddard gibi)
editoryal, sol hizalı ve boşluk odaklı tasarım dilinden ilham alınarak
yeniden tasarlandı. Tüm sayfalar `public/assets/kulaktan.css` dosyasındaki
ortak sistemi kullanır:

- **Renk**: `ink` (lacivert-siyah), `paper` (soğuk taş rengi zemin), `brass`
  (tek vurgu rengi — pirinç/bronz tonu), `slate` (gövde metni grisi).
- **Tipografi**: Başlıklarda **Fraunces** (editoryal serif), her yerde
  (navigasyon, gövde, formlar) **Archivo** (çağdaş grotesk). İkisi de Google
  Fonts üzerinden yükleniyor.
- **İmza motif — "redaksiyon çubuğu"**: Küçük dolgu çubuklar, gizlenmiş/
  sansürlenmiş bir belge satırını çağrıştırıyor; madde işaretleri, ayraçlar ve
  vurgular bu tek şekilden türetiliyor — whistleblowing/gizlilik temasına
  doğrudan bağlı, özgün bir görsel fikir.
- **Sıfır üçüncü parti script bağımlılığı**: Önceki sürümde `index.html`
  Tailwind Play CDN ve Lucide ikon CDN'sine bağımlıydı (ve bu, CDN engellenirse
  sayfanın geri kalan JavaScript'ini sessizce bozan gerçek bir kırılganlıktı —
  düzeltildi). Yeni tasarımda hiçbir sayfa harici script'e ihtiyaç duymuyor;
  sadece Google Fonts (zaten CSP'de izinli) kullanılıyor. Bu sayede
  `Content-Security-Policy` header'ı da sıkılaştırıldı.

Logoyu veya renkleri değiştirmek isterseniz `public/assets/kulaktan.css`
dosyasındaki `:root` değişkenlerini güncellemeniz yeterli — tüm sayfalar
otomatik olarak yeni değerleri kullanır.

## Gerçek e-posta göndermek isterseniz

[Resend](https://resend.com)'den bir API anahtarı alıp `.env` dosyasına
`RESEND_API_KEY=...` ekleyin. Anahtar yoksa e-postalar (şifre sıfırlama
bağlantıları dahil) **sunucu konsoluna yazdırılır** — bu sayede gerçek bir
e-posta sağlayıcısı kurmadan önce de sistemi tam olarak test edebilirsiniz.

## Yayına almadan önce kontrol listesi

Kod hazır, ama bir yayına almadan önce mutlaka şunları yapın:

- [ ] **`kvkk.html` ve `kullanim-sartlari.html`** içindeki <span style="color:#a9782e">turuncu işaretli</span> tüm alanları (şirket unvanı, adres, MERSİS no, yetkili mahkeme vb.) gerçek bilgilerinizle doldurun ve bir hukuk danışmanına kontrol ettirin.
- [ ] `.env` dosyasında `APP_BASE_URL=https://kulaktan.com.tr` olarak ayarlı olduğundan emin olun (şifre sıfırlama linkleri ve SEO canonical URL'leri için).
- [ ] `CONTACT_EMAIL`, `COMPLIANCE_EMAIL`, `BOARD_EMAIL` değerlerini gerçek e-posta adreslerinizle girin; `RESEND_API_KEY` eklemezseniz bu formlar konsola loglanır, gerçekten gönderilmez.
- [ ] `public/sitemap.xml` içindeki URL'lerin güncel olduğunu doğrulayın; yayına aldıktan sonra Google Search Console'a gönderin.
- [ ] İletişim sayfasındaki (`iletisim.html`) `info@kulaktan.com.tr` mailto linkini gerçek adresinizle güncelleyin.
- [ ] Fiyatlandırma sayfasındaki model açıklamasını gözden geçirin — rakam içermiyor, sadece yapıyı anlatıyor; isterseniz gerçek rakamlar ekleyin.
- [ ] Kurucu/ekip bilgilerini (`iletisim.html`) güncel tutun.

## Dağıtım (deployment)

- Node.js 22+ çalıştırabilen herhangi bir yer: VPS, Railway, Render, Fly.io.
- `data/` klasörü **kalıcı bir diskte** olmalı (bazı "serverless" platformlar
  dosya sistemini sıfırlar — kalıcı disk/volume destekli bir platform seçin).
- `.env` dosyasını asla git'e koymayın.
- `NODE_ENV=production` ayarlayın ve HTTPS arkasında sunun.
- `APP_BASE_URL`'i gerçek domaininize ayarlayın (şifre sıfırlama linkleri için).

### kulaktan.com.tr için kurulum (VPS + nginx + Let's Encrypt örneği)

1. **DNS**: Domain sağlayıcınızda `kulaktan.com.tr` (ve isterseniz `www.kulaktan.com.tr`)
   için bir **A kaydı** oluşturup sunucunuzun IP adresine yönlendirin.
2. **Sunucuda Node.js 22+ kurun** ve projeyi sunucuya kopyalayın (`git clone`
   veya `scp` ile), `.env` dosyasını oluşturup gerçek `KULAKTAN_MASTER_KEY`
   ve `APP_BASE_URL=https://kulaktan.com.tr` değerlerini girin.
3. **Kalıcı çalıştırma için bir process manager kullanın** (sunucu yeniden
   başlasa bile ayakta kalsın), örn. `pm2`:
   ```bash
   npm install -g pm2   # (bu tek npm bağımlılığı sunucu için, projenin kendisi için değil)
   pm2 start "node --env-file=.env server.js" --name kulaktan
   pm2 save && pm2 startup
   ```
4. **nginx'i ters proxy olarak kurun** (`/etc/nginx/sites-available/kulaktan.com.tr`):
   ```nginx
   server {
       listen 80;
       server_name kulaktan.com.tr www.kulaktan.com.tr;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   Sonra: `ln -s /etc/nginx/sites-available/kulaktan.com.tr /etc/nginx/sites-enabled/`
   ve `nginx -t && systemctl reload nginx`.
   
   `X-Forwarded-For` header'ını nginx ayarladığı için `lib/rate-limit.js`
   içindeki `clientIp()` fonksiyonu gerçek istemci IP'sini doğru okuyacaktır
   (bu header sadece güvendiğiniz bir ters proxy arkasındayken güvenlidir —
   nginx bunu garanti eder çünkü kendi üstüne yazar).
5. **HTTPS sertifikası (ücretsiz, Let's Encrypt)**:
   ```bash
   apt install certbot python3-certbot-nginx
   certbot --nginx -d kulaktan.com.tr -d www.kulaktan.com.tr
   ```
   Certbot nginx yapılandırmanızı otomatik günceller ve sertifikayı otomatik
   yeniler.
6. `.env` dosyanızda `NODE_ENV=production` olduğundan emin olun (oturum
   çerezlerinin `Secure` bayrağı için HTTPS şart).

### kulaktan.com.tr için Render'a deploy (önerilen — Blueprint ile tek adım)

Projede hazır bir `render.yaml` dosyası var; bu dosya web servisini, kalıcı
diski ve gerekli ortam değişkenlerini otomatik tanımlar.

**Önemli maliyet notu**: Render'ın ücretsiz planı kalıcı disk desteklemiyor,
ve bizim SQLite veritabanımız kalıcı disk gerektiriyor (aksi halde her
deploy'da veriler silinir). Bu yüzden en az **Starter plan** (küçük, sabit
aylık ücret) gerekiyor — güncel fiyat için Render'ın fiyatlandırma sayfasına
bakın, sık güncelleniyor.

**Adımlar:**

1. **Projeyi bir Git deposuna (GitHub/GitLab) push edin** — Render buradan
   deploy eder, zip dosyasından doğrudan deploy desteklemez.
   ```bash
   cd kulaktan
   git init && git add . && git commit -m "İlk sürüm"
   # GitHub'da boş bir repo oluşturup:
   git remote add origin https://github.com/kullanici-adiniz/kulaktan.git
   git push -u origin main
   ```
   `.env` dosyasının repoya **eklenmediğinden** emin olun (zaten `.gitignore`
   eklemediyseniz şimdi ekleyin: `echo ".env" >> .gitignore`).

2. **Render Dashboard'da**: "New +" → "Blueprint" → GitHub hesabınızı bağlayıp
   `kulaktan` reposunu seçin. Render `render.yaml`'ı otomatik okur ve şunları
   önerir: bir web servisi (`kulaktan`, Starter plan), 1GB'lık kalıcı disk,
   ve `KULAKTAN_MASTER_KEY` için otomatik üretilmiş güvenli bir değer.
   "Apply" deyip deploy'u başlatın.

3. **E-posta değişkenlerini girin** (isteğe bağlı ama önerilir): Servis
   ayarlarında "Environment" sekmesinden `RESEND_API_KEY`, `EMAIL_FROM`,
   `COMPLIANCE_EMAIL`, `BOARD_EMAIL` değerlerini girin (render.yaml'da bunlar
   `sync: false` olarak işaretli, yani Render sizden dashboard'dan girmenizi
   ister, değerler asla repoda görünmez).

4. **DNS ayarları** (domaininizi satın aldığınız sağlayıcının DNS panelinde):
   Render servis ayarlarında "Custom Domains" sekmesi size tam olarak hangi
   kayıtları ekleyeceğinizi gösterir, ama genel olarak:
   - **Kök domain** (`kulaktan.com.tr`): bir **A kaydı**, host `@`, değer
     `216.24.57.1` (Render'ın yük dengeleyici IP'si).
   - **www alt alanı** (`www.kulaktan.com.tr`): bir **CNAME kaydı**, host
     `www`, değer Render'ın size verdiği `kulaktan.onrender.com` benzeri adres.
   - DNS sağlayıcınız **ANAME/ALIAS** kaydını destekliyorsa (bazı Türk
     sağlayıcılar desteklemiyor, kontrol edin), kök domain için A kaydı yerine
     ANAME/ALIAS ile doğrudan `kulaktan.onrender.com`'a yönlendirmek daha
     sağlamdır (IP değişse bile bozulmaz).
   - Varsa **AAAA kayıtlarını silin** — Render IPv6 desteklemiyor, AAAA
     kayıtları SSL sertifikası doğrulamasını bozabilir.
   - DNS yayılması genelde birkaç dakika ile birkaç saat sürer. Yayıldıktan
     sonra Render otomatik olarak ücretsiz bir SSL sertifikası kurar.

5. **Doğrulama**: `https://kulaktan.com.tr` açıldığında ana sayfa gelmeli.
   `node --env-file=.env lib/create-superadmin.js` komutunu **Render'ın Shell
   sekmesinden** (dashboard'da servisinize tıklayıp "Shell") çalıştırarak ilk
   süper-admin hesabınızı oluşturun — çünkü bu komutun `KULAKTAN_MASTER_KEY`'e
   ihtiyacı var ve o değer sadece Render'ın ortamında mevcut.
   ```bash
   # Render Shell'de (--env-file'a gerek yok, Render zaten process.env'e enjekte eder):
   node lib/create-superadmin.js "Adınız Soyadınız" kullaniciadi email@kulaktan.com.tr
   node lib/seed.js   # isterseniz demo/varsayılan şirketi de oluşturur
   ```

**Blueprint kullanmak istemezseniz**, aynı ayarları Render Dashboard'dan
elle de girebilirsiniz: "New +" → "Web Service" → repo seçin → Runtime:
Node → Start Command: `node server.js` → Plan: Starter → "Advanced"
altından bir disk ekleyin (mount path `/var/data`) → ortam değişkenlerini
`.env.example`'a bakarak tek tek girin.

### Diğer platformlar (Railway, Fly.io, kendi VPS'iniz)

Yukarıdaki VPS + nginx + Let's Encrypt adımları herhangi bir Linux
sunucusunda geçerlidir. Railway/Fly.io kullanıyorsanız mantık aynıdır:
kalıcı disk/volume açın, `KULAKTAN_DB_PATH`'i o diske işaret edecek şekilde
ayarlayın, ortam değişkenlerini girin, start command olarak `node server.js`
kullanın (yerelde çalıştırdığınız `--env-file=.env` bayrağına bu
platformlarda gerek yok — hepsi ortam değişkenlerini doğrudan
`process.env`'e enjekte eder).

## Test

Bu sürümde ayrıca gerçek bir tarayıcıda (Playwright) test edilenler:

- Tam iş akışı: gönderim → takip → atama → mütalaa → YK kararı → sonuç.
- **Çapraz-kiracı (cross-tenant) saldırı denemeleri**: Bir şirketin admin'i
  başka bir şirketin dosyasına erişmeye/atama yapmaya çalıştı → reddedildi.
- CSRF token'sız istek → reddedildi; doğru token ile → kabul edildi.
- 5 başarısız giriş → hesap kilitlendi; doğru şifreyle bile giriş engellendi.
- Şifre sıfırlama: geçersiz token reddedildi, doğru token bir kez kullanıldı,
  eski şifre artık çalışmıyor, yeni şifre çalışıyor.
- Denetim zinciri: veritabanına doğrudan (API dışından) müdahale edildiğinde
  "Zincir Bütünlüğü" doğrulaması bunu yakaladı.
- **Süper-admin akışı**: yeni şirket oluşturma, personel ekleme, marka rengi
  güncelleme — hem API hem gerçek tarayıcı arayüzünden test edildi. Rengin
  gerçekten şirketin `/o/<slug>` sayfasındaki gönder butonuna uygulandığı
  tarayıcıda ölçülerek doğrulandı.
- **Yetki yükseltme (privilege escalation) denemesi**: sıradan bir admin
  hesabıyla süper-admin uç noktalarına erişim denendi → reddedildi.


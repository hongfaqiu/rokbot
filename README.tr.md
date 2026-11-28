<p align="center">
  <img src="assets/logo/rokbot-logo.svg" width="112" alt="RokBot" />
</p>

<h1 align="center">RokBot</h1>

<p align="center">
  Kendi sunucunuzda özel bir yapay zeka asistanı: verileriniz yerelde kalır, modelleri siz seçersiniz ve web, masaüstü veya telefonda kaldığınız yerden devam edebilirsiniz.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Noncommercial%201.0-f59e0b?style=flat-square" alt="Lisans: RokBot Ticari Olmayan Lisans 1.0" /></a>
  <a href="docs/clients.en.md"><img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android%20%7C%20Web-111827?style=flat-square" alt="Platformlar: macOS, Windows, Linux, iOS, Android, Web" /></a>
  <a href="#hızlı-başlangıç"><img src="https://img.shields.io/badge/Deploy-Docker%20Compose-0ea5e9?style=flat-square" alt="Dağıtım: Docker Compose" /></a>
</p>

<p align="center">
  <a href="docs/media/rokbot-promo.mp4">
    <img src="docs/media/rokbot-promo-teaser.webp" width="800" alt="RokBot tanıtım fragmanı: Bot'un bilgisayarı, çoklu cihaz geçişi, görsel üretimi, sesli sohbet ve model seçimi" />
  </a>
  <br />
  <sub><a href="docs/media/rokbot-promo.mp4">Tam tanıtım videosunu izleyin (80 saniye, anlatımlı; Çince)</a></sub>
</p>

<!-- 用户可在 GitHub 网页编辑器中把 mp4 拖入此处，生成 user-attachments 链接后即可内嵌播放 -->

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <strong>Türkçe</strong> ·
  <a href="#özellikler">Özellikler</a> ·
  <a href="#yeni-yönelimler--yol-haritası">Yol Haritası</a> ·
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> ·
  <a href="#i̇stemcileri-edinin">İstemcileri Edinin</a> ·
  <a href="#rokbot-yukarı-akıştan-nasıl-ayrılır">Yukarı Akış Karşılaştırması</a> ·
  <a href="#belgeler">Belgeler</a>
</p>

## Özellikler

### <img src="docs/images/icons/server.svg" width="22" height="22" alt="" /> Kendi Sunucunuzda Barındırma ve Veri

<img src="site/img/admin-models.webp" width="420" align="right" alt="Yönetici konsolu Sohbet modeli sayfası: sağlayıcılar, profiller ve varsayılan rota" />

- **Verileriniz makinenizde kalır:** Host ve yürütme masaüstü sunucunuzda Docker içinde çalışır; sohbetler, dosyalar, ayarlar ve API anahtarları yerel birimlerde tutulur ve her istemcide telemetri kapalıdır.
- **Kendi modellerinizi seçin:** OpenAI Chat Completions, OpenAI Responses ve Anthropic Messages ile çalışır; hangi sağlayıcı ve modeli kullanacağınıza siz karar verirsiniz.
- **Senaryoya göre model yönlendirme:** Girdi önerileri, bağlam sıkıştırma, bellek çıkarma, otomatik inceleme, alt ajanlar ve rutinlerin her biri kendi modelini ve akıl yürütme düzeyini kullanabilir; ayrıca herhangi bir Bot'un da kendi modeli olabilir.
- **Ana model başarısız olduğunda otomatik yedekleme:** Her rota en fazla 8 yedek model alır; hata durumunda RokBot otomatik olarak geçiş yapar ve akışı başlamış bir yanıtın ortasında asla model değiştirmez.
- **Grok Bot'tan geçiş yapın:** Yerel Grok Bot verilerini tek tıkla okuyun veya Grok Bot'un anılarını, becerilerini ve rutinlerini dışa aktarması için bir geçiş istemi kopyalayın; inceleyin, ardından yineleme olmadan istediğiniz sıklıkta içe aktarın. Bkz. [geçiş kılavuzu](docs/migrate-from-grokbot.md) (Çince).
- **Sayfalı yönetici konsolu:** Yönetici konsolu sol gezinme menüsüyle Genel Bakış, Modeller, Kullanım, İstemciler, Cihazlar, Botlar, Hesap ve Sistem sayfalarına bölünmüştür; her sayfa yalnızca kendi modüllerini yükler ve dar ekranlarda gezinme bir menüye katlanır.
- **Bulut hesabı gerekmez:** Tek kullanımlık 6 haneli bir kodla eşleştirin ve Host'a yerleşik Tailcat ağı, Tailscale veya bir HTTPS ters proxy üzerinden uzaktan erişin.

<br clear="right" />

<table>
  <tr>
    <td align="center"><img src="docs/images/readme/android-migrate.webp" width="200" alt="Android istemcisi Grok Bot'tan Geçiş sayfası" /><br /><sub>Grok Bot'tan geçiş</sub></td>
  </tr>
</table>

### <img src="docs/images/icons/devices.svg" width="22" height="22" alt="" /> Her Platform

<img src="site/img/desktop-chat.webp" width="420" align="right" alt="Masaüstü sohbet penceresi" />

- **Altı platform:** Web, Mac, Windows, Linux (x64 / arm64), Android ve iOS aynı Host'a bağlanır; böylece bilgisayarınızda başlattığınız bir görevi telefonunuzdan takip edebilirsiniz.
- **Masaüstü otomatik güncelleme:** Masaüstü 1.3.3, kendi Host'unuzdaki İstemci güncellemeleri üzerinden yeni sürümleri denetler ve yalnızca değişenleri indiren delta güncellemeleri destekler.
- **Android yerinde yükseltme:** Android sürümlerinin tümü RokBot sürüm anahtarıyla imzalanmıştır; bu nedenle yeni sürüm, eskisini kaldırmadan üzerine kurulur.
- **Yerel Android istemcisi:** Yerel ekranlar artı sistem paylaşımı, yerel bir görsel görüntüleyici ve galeriye çoklu seçimle toplu kaydetme.

<br clear="right" />

### <img src="docs/images/icons/message.svg" width="22" height="22" alt="" /> Sohbet Deneyimi

- **Girdi önerileri:** Yazma alanı odaklandığında, mevcut konuşmadan üretilen öneriler üstünde görünür ve tek dokunuşla gönderilir; boş bir sohbette yalnızca Host üzerinde tutulan ve istemciler arasında senkronize edilen hızlı ifadeleriniz gösterilir. Çubuğu tamamen veya yalnızca yapay zeka üretimi kısmını kapatabilirsiniz.
- **Satır içi tamamlama:** Siz yazarken gri hayalet metin cümlenin geri kalanını önerir; kabul etmek için Tab veya Sağ Ok tuşuna basın. IME uyumludur ve kendi anahtarına sahiptir.
- **Hızlı ve asla yanlış Bot'tan değil:** Öneriler Bot başına tutulur ve her Bot yanıtından sonra önceden getirilir; böylece odaklanmadan öneriye kadar geçen süre yaklaşık 1960 ms'den yaklaşık 165 ms'ye düşer; üretilirken bir parıltı görünür ve ayarlar Ayarlar'ın en üst düzeyinde yer alır.
- **Boyut sınırı olmadan yüklemeler:** Bilgisayarınız ile Bot'un çalışma alanı arasındaki dosyalar parçalar hâlinde aktarılır ve varsayılan olarak dosya başına boyut sınırı yoktur.
- **Ses:** Yapılandırdığınız hizmetlerde konuşma tanıma ve sentezleme ile sesli giriş ve sesli aramalar.
- **Görsel üretimi:** Görsel ve video üretiminin her biri kendi modelini alır, sonuçlar ek olarak gelir ve aynı anda birkaçını toplu olarak indirebilirsiniz.

<table>
  <tr>
    <td align="center"><img src="docs/images/readme/android-suggestions.webp" width="200" alt="Yazma alanının üzerinde girdi önerileriyle Android istemcisi" /><br /><sub>Girdi önerileri</sub></td>
    <td align="center"><img src="site/img/android-image-generation.webp" width="200" alt="Görsel üreten bir tasarım Bot'uyla sohbet eden Android istemcisi" /><br /><sub>Görsel üretimi</sub></td>
  </tr>
</table>

### <img src="docs/images/icons/canvas.svg" width="22" height="22" alt="" /> Canvas

- **Bot'larınızdan etkileşimli sayfalar:** Bir Bot, resmî bir bulut olmadan kendi Host'unuz tarafından barındırılan web sayfaları, grafikler ve küçük araçları canvas olarak yazar.
- **Uygulama içinde açılır:** Web, masaüstü, Android ve iOS canvas'ları doğrudan uygulamanın içinde açar.
- **Varsayılan olarak özel, istendiğinde herkese açık:** Yeni bir canvas yalnızca size görünür; paylaşmak kopyalayabileceğiniz veya yeniden oluşturabileceğiniz herkese açık bir bağlantı oluşturur ve paylaşımı kaldırmak bağlantıyı anında iptal eder.
- **Bot ayrıntılarında Canvas listesi:** Bir Bot'un oluşturduğu her canvas'ı ayrıntılar sayfasından görün, açın ve yönetin.

### <img src="docs/images/icons/chart.svg" width="22" height="22" alt="" /> Kullanım İstatistikleri

<img src="docs/images/readme/android-usage.webp" width="200" align="right" alt="Android istemcisi kullanım raporu" />

- **Her çağrı kaydedilir:** Host her model çağrısının modelini, Bot'unu, süresini ve durumunu kaydeder.
- **Her istemcide:** Yönetici konsolu, masaüstü ve web ayarları, Android ve iOS'un tümünde zaman aralıkları, filtreler, eğilimler, kırılımlar ve istek başına ayrıntı içeren bir kullanım raporu bulunur.
- **CSV dışa aktarma:** Raporu CSV olarak dışa aktarın; API [docs/usage-report.md](docs/usage-report.md) (Çince) dosyasında açıklanmıştır.

<br clear="right" />

### <img src="docs/images/icons/bot.svg" width="22" height="22" alt="" /> Kendini Yöneten Botlar

<img src="docs/images/readme/android-bot-detail.webp" width="200" align="right" alt="Rutinler, kitaplık, Bot'un bilgisayarı ve talimatlarıyla Android istemcisi Bot ayrıntıları" />

- **Bellek:** Bir Bot, kendi Host'unuzdaki uzun süreli belleğini güncelleyebilir ve hatırlayabilir.
- **Rutinler:** Bir Bot kendi rutinlerini düzenleyebilir ve çalışma geçmişlerini kontrol edebilir.
- **İzlenen görevler:** İzlenen görevlerin ilerlemesi ve sonuçları konuşmada görünür.
- **Profil düzenlemeleri:** Bir Bot kendi profilini güncelleyebilir.
- **Beceri yazma:** Bir Bot kendi becerilerini yazabilir ve güncelleyebilir.
- **Yeni Botlar:** Bir Bot doğrudan yeni ajanlar oluşturabilir.
- **Akıl yürütme düzeyi:** Bir Bot kendi akıl yürütme düzeyini ayarlayabilir.
- **Sohbette formlar:** Bir Bot daha fazla bilgiye ihtiyaç duyduğunda, doldurmanız için konuşmada bir form açar.

<br clear="right" />

### <img src="docs/images/icons/users.svg" width="22" height="22" alt="" /> Grup Sohbetleri

- **Çoklu Bot grup sohbetleri:** Birlikte çalışmaları için grup başına en fazla 6 Bot olmak üzere birkaç Bot'u tek bir grupta bir araya getirin.
- **Android grup oluşturma masaüstüyle eşleşir:** Android artık grupları "Kime:" alıcı çubuğuyla tek sayfada oluşturur ve grupları masaüstüyle aynı şekilde adlandırır.
- **Seçerken oluşturun:** Üye seçiciden doğrudan yeni bir Bot oluşturup gruba ekleyebilirsiniz.
- **Otomatik geri alma:** Grup oluşturma başarısız olursa tamamlanan adımlar geri alınır, böylece yarım kalmış bir grup bırakılmaz.

<table>
  <tr>
    <td align="center"><img src="docs/images/readme/android-chat-list.webp" width="200" alt="Devam eden ve Okundu olarak gruplanmış Android istemcisi sohbet listesi" /><br /><sub>Duruma göre gruplanmış sohbet listesi</sub></td>
    <td align="center"><img src="docs/images/readme/android-create-group.webp" width="200" alt="Kime: alıcı çubuğuyla Android istemcisi Grup sohbeti oluşturma" /><br /><sub>Grup sohbeti oluşturma</sub></td>
  </tr>
</table>

### <img src="docs/images/icons/palette.svg" width="22" height="22" alt="" /> RokBot'un Kendi Tasarımı

- **RokBot'un kendi seçicileri ve denetimleri:** Model yönlendirme sayfalarındaki yerel sistem açılır menüleri, Android'de alt sayfalar olarak gösterilen RokBot tarzı menülerle değiştirilmiştir.
- **Açık ve koyu temalar:** Menüler, alt sayfalar ve ayarlar sistem temasını ve Çince veya İngilizce arayüzü izler.
- **Hareketli avatarlar:** Botlar varsayılan olarak 26 şekil arasında RokBot hareketli avatarlarını ve uygulama içi stil değiştiricisini kullanır.
- **Birleşik simgeler:** Masaüstü, uygulama içi ve Hakkında sayfası simgelerinin tümü RokBot işaretini kullanır.

<table>
  <tr>
    <td align="center"><img src="docs/images/readme/android-settings.webp" width="200" alt="RokBot üst düzey girdileriyle Android istemcisi Ayarlar" /><br /><sub>RokBot girdileriyle Ayarlar</sub></td>
    <td align="center"><img src="site/img/android-models.webp" width="200" alt="Android istemcisi model ayarları sayfası" /><br /><sub>Model ayarları</sub></td>
  </tr>
</table>

### <img src="docs/images/icons/monitor.svg" width="22" height="22" alt="" /> Uzak Bilgisayar ve Yerel Yürütme

<img src="site/img/desktop-live-vnc.webp" width="420" align="right" alt="Bot'un bilgisayarını canlı izleyen ve devralan masaüstü istemcisi" />

- **Bot'un bilgisayarı:** Bot'u VNC üzerinden canlı olarak izleyebileceğiniz ve devralabileceğiniz yerleşik bir Linux masaüstü kapsayıcısı.
- **Uzak yürütme düğümü:** Yerleşik masaüstü, yönetici konsolundaki Yürütme ortamı altından uzak bir Linux makinesiyle değiştirilebilir.
- **Kendi bilgisayarınızda çalışın:** Bir Bot, Mac'te komutlar çalıştırabilir ve GUI'yi kontrol edebilir, Windows'ta ise yerel komutlar çalıştırabilir.
- **Açık port yok:** İstemciler dışarıya doğru Host'a bağlanır, bu nedenle bilgisayarınız asla bir port açmaz; hassas eylemler önce otomatik inceleme ve onay kartlarından geçer.
- **Okuma tek bir klasörle sınırlı değildir:** Bir Bot; SSH/GPG anahtarları, bulut ve GitHub CLI kimlik bilgileri, anahtar zincirleri, tarayıcı parolaları ve çerezleri, kimlik bilgisi dosyaları ve RokBot'un kendi oturum açma verileri (sembolik bağlantı üzerinden erişildiğinde de dâhil) hariç bilgisayarınızın herhangi bir yerinden dosya okuyabilir, klasör listeleyebilir ve kendi bilgisayarına dosya kopyalayabilir. Bilgisayarınıza yazma, silme ve dosya kopyalama işlemleri hâlâ önce onay veya otomatik incelemeden geçer.

<br clear="right" />

### <img src="docs/images/icons/terminal.svg" width="22" height="22" alt="" /> rokbot CLI

- **İşlemler için tek komut:** `rokbot`; dağıtım, yönetici kurulumu, ortam kontrolleri, güncelleme ve geri alma ile yerel paketlemeyi kapsar. Yalnızca Node.js 20+ gerektirir ve üçüncü taraf bağımlılığı yoktur.
- **Doğrudan çalıştırın:** `npx rokbot --help` ve `npx rokbot doctor`, veya `npm i -g rokbot` ile kurup `rokbot init`, `rokbot up` ve `rokbot update` kullanın.
- **Geri alabileceğiniz güncellemeler:** Her güncelleme önce yedek alır ve bir geri alma noktası kaydeder; böylece `rokbot rollback` sizi geri götürür; bkz. [CLI kılavuzu](docs/cli.md) (Çince).

Tam özellik kılavuzu için [docs/features.en.md](docs/features.en.md), daha fazla ekran için [Ekran Görüntüleri](docs/screenshots.en.md) ve son değişiklikler için [2026-11-27 sürüm notları](docs/releases/2026-11-27.md) (Çince) belgelerine bakın.

## Yeni Yönelimler & Yol Haritası

<img src="docs/images/icons/map.svg" width="22" height="22" alt="" /> Aşağıdaki özellikler geliştirme aşamasındadır veya planlanmaktadır ve **henüz kullanılamamaktadır**:

| Özellik | Açıklama | Durum |
| --- | --- | --- |
| iOS özellik eşliği | iOS istemcisinin satır içi tamamlama, uygulama içi canvas ve paylaşım ile diğer yeni özellikleri yakalaması | Geliştirme aşamasında |

## Hızlı Başlangıç

<img src="docs/images/icons/rocket.svg" width="22" height="22" alt="" /> Docker (Compose v2 dâhil) kurulu bir Linux veya macOS sunucusunda:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub username> --password-stdin
gh repo clone hongfaqiu/rokbot rokbot-src
mkdir rokbot && cd rokbot
bash ../rokbot-src/host/release/install-images.sh --local
docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
```

`http://127.0.0.1:18080/admin` adresini açın, yönetici parolası belirlemek için kurulum anahtarını kullanın, ardından Sohbet modeli altında bir model hizmeti ekleyin ve bunu varsayılan rota yapın.

Dağıtımı; dağıtım, yönetici parolası, ortam kontrolleri, güncelleme ve geri alma ile yerel paketlemeyi yöneten `rokbot` CLI ile de yapabilirsiniz:

```bash
npx rokbot doctor   # Node, Docker, portlar, disk ve sertifikaları kontrol et
npx rokbot init     # sihirbaz: görüntü veya kaynak modunu seç ve yapılandırmayı yaz
npx rokbot up       # Host'u ve yürütme masaüstünü başlat
npx rokbot admin    # yönetici parolasını ilk kez ayarla
```

Veya `npm i -g rokbot` ile kurun ya da kaynak kodundan `bash scripts/install-cli.sh` çalıştırın; bkz. [CLI kılavuzu](docs/cli.md) (Çince). Grok Bot'tan mı geliyorsunuz? Dağıtımdan sonra Bot'larınızı, anılarınızı ve becerilerinizi taşımak için [Grok Bot'tan Geçiş](docs/migrate-from-grokbot.md) (Çince) kılavuzunu izleyin.

Seçenekler, çevrimdışı kurulumlar, kaynaktan derlemeler ve yapay zeka destekli dağıtım için [Dağıtım Kılavuzu](docs/deployment.en.md) · [Yapay Zeka Ajanı Dağıtım Kılavuzu](docs/AGENT_DEPLOY.en.md) · [İşlemler ve Yedekleme](docs/AI-INSTALL.en.md) belgelerine bakın.

## İstemcileri Edinin

<img src="docs/images/icons/download.svg" width="22" height="22" alt="" /> Bu depo yükleyici dağıtmaz. [İstemcileri Edinme](docs/clients.en.md) kılavuzunu izleyerek resmî yükleyicileri kendiniz yamalayın veya dağıtılmış bir Host'taki İstemci güncellemeleri bölümünden indirin, ardından yönetici konsolundan alınan 6 haneli bir kodla eşleştirin.

Yamalama (`rokbot pack` dâhil) kendi sağladığınız orijinal resmî yükleyiciyi gerektirir: orijinal Android paketi [APKPure](https://apkpure.com/grok-bot/ai.x.grok.bot) üzerinden, orijinal iOS paketi (IPA) ise [IPA Filezone](https://ipafilezone.com/app/x-corp/grok-bot/6794501026) üzerinden edinilebilir.

## RokBot Yukarı Akıştan Nasıl Ayrılır

<img src="docs/images/icons/compare.svg" width="22" height="22" alt="" /> RokBot, yukarı akış açık kaynak projeleri olan [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) ve [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus) projelerinden türetilmiştir (bkz. [NOTICE](NOTICE)).

| Alan | Resmî uygulama | ProkBot | prokbot-plus | RokBot |
| --- | --- | --- | --- | --- |
| Barındırma ve veri | Resmî bulut | Kendi sunucusunda Docker | Kendi sunucusunda, ARM64 ve yedekleme/geri yükleme ile | Tek betikli önceden derlenmiş görüntü dağıtımıyla kendi sunucusunda |
| Model yönlendirme | Yalnızca resmî modeller | Kendi modelini getir | Bot başına rotalar ve yedeklemeler | 6 senaryo rotası, her biri için en fazla 8 yedek |
| İstemciler | Resmî uygulamalar | macOS, iOS | Windows ve web ekler | Altı platform; Linux ve yerel Android ekler |
| Sohbet ve Botlar | Resmî bulut özellikleri | Çekirdek sohbet ve bulut masaüstü | Uygulama kataloğu, webhook'lar, kullanım istatistikleri | Girdi önerileri ve tamamlama, yerel canvas, kullanım raporları, kendini yöneten Botlar, yerel grup oluşturma |
| Gizlilik | Resmî hesap ve telemetri | Telemetri kapalı | Telemetri kapalı | Her yerde telemetri kapalı, yalnızca yazılabilir API anahtarları |

## Belgeler

<img src="docs/images/icons/book.svg" width="22" height="22" alt="" />

| Belge | İçerik |
| --- | --- |
| [docs/features.en.md](docs/features.en.md) | Tam özellik kılavuzu |
| [docs/screenshots.en.md](docs/screenshots.en.md) | Android, masaüstü ve yönetici konsolu ekran görüntüleri |
| [docs/cli.md](docs/cli.md) | rokbot CLI: dağıtım, yönetici, kontroller, güncelleme ve geri alma, paketleme (Çince) |
| [docs/migrate-from-grokbot.md](docs/migrate-from-grokbot.md) | Grok Bot'tan Botları, anıları, becerileri, rutinleri ve sohbetleri taşıma (Çince) |
| [docs/usage-report.md](docs/usage-report.md) | Kullanım raporu API'si ve ekran yapısı (Çince) |
| [docs/deployment.en.md](docs/deployment.en.md) | Dağıtım adımları, betik bayrakları, başlatma ve model kurulumu |
| [docs/clients.en.md](docs/clients.en.md) | Desteklenen sürümler, platform başına derleme komutları ve Host dağıtımı |
| [docs/architecture-overview.en.md](docs/architecture-overview.en.md) | Mimariye genel bakış |
| [docs/faq.en.md](docs/faq.en.md) | SSS ve dağıtım/uyumluluk notları |
| [docs/releases/2026-11-27.md](docs/releases/2026-11-27.md) | 2026-11-27 sürüm notları (Çince) |
| [docs/AGENT_DEPLOY.en.md](docs/AGENT_DEPLOY.en.md) | Yapay zeka kodlama ajanları için dağıtım kılavuzu |
| [docs/AI-INSTALL.en.md](docs/AI-INSTALL.en.md) | `host/deploy.py` dağıtımı, işlemler ve yedekleme/geri yükleme |
| [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | Tam teknik mimari ve dizin düzeni |
| [docs/PATCHING_WORKFLOW.en.md](docs/PATCHING_WORKFLOW.en.md) | Yama temelleri ve bakım iş akışı |
| [docs/REBRAND_COMPAT.md](docs/REBRAND_COMPAT.md) | Yeniden adlandırma kayıt defteri ve eski kurulumlardan geçiş |
| [tests/e2e/README.md](tests/e2e/README.md) | Uçtan uca testlerin nasıl çalıştırılacağı |
| [SECURITY.md](SECURITY.md) | Güvenlik açığı bildirimi ve dağıtım güvenliği tavsiyeleri |

## Lisans

<img src="docs/images/icons/scale.svg" width="22" height="22" alt="" /> RokBot, [RokBot Ticari Olmayan Lisans 1.0](LICENSE) altında lisanslanmıştır: kişisel kullanım, kendi sunucunuzda barındırma, inceleme, değiştirme ve ticari olmayan yeniden dağıtıma izin verilir ve her türlü ticari kullanım yasaktır. ProkBot'tan türetilen kısımlar da [ProkBot Ticari Olmayan Lisans 1.0](LICENSES/ProkBot-Noncommercial-1.0.txt) kapsamında kalır. Türetme ve üçüncü taraf bildirimleri için [NOTICE](NOTICE) dosyasına, uyumluluk notları için [docs/faq.en.md](docs/faq.en.md#distribution--compliance) belgesine bakın.

## Teşekkürler

RokBot, [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) ve [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus) üzerine kuruludur ve `rakazo`'nun kendi sunucuda barındırma dağıtımı çalışmasından yararlanmıştır. Hepsine teşekkür ederiz. Dostlar: [LINUX DO](https://linux.do).

## Sorumluluk Reddi

RokBot bağımsız bir açık kaynak projesidir ve xAI, resmî Grok Bot veya Cursor / Anysphere ile bağlantılı değildir veya bunlar tarafından desteklenmez; Grok, Grok Bot ve ilgili adlar ile markalar kendi sahiplerine aittir. Lütfen güvenlik sorunlarını [SECURITY.md](SECURITY.md) üzerinden özel olarak bildirin.

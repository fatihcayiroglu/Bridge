# Jest sure siniri politikasi (`testTimeout`)

## Neden varsayilan 10 sn degil

Sunucu paketi **443 test paketini paralel** kosar. Jest'in varsayilan
`testTimeout` degeri **10 saniyedir** ve bu deger TEK bir testin ne kadar
surdugunu degil, o testin **CPU'ya ne zaman erisebildigini** olcer.

Olculen belirti tam olarak buydu: tam kosumda rastgele **tek** bir paket
"Exceeded timeout of 10000 ms" ile dusuyor, ayni paket **izole** kosumda
saniyeler icinde geciyordu. Uc ayri ornek gozlendi:

| Paket | Izole sonuc | Paralel sonuc |
| --- | --- | --- |
| `twofactor-disable-authz.test.ts` | 11/11 gecti (5.7 sn) | zaman asimi |
| `webauthn-assertion-error-paths.test.ts` | 68/68 gecti | zaman asimi |
| `serverGifs.test.ts` | 17/17 gecti | zaman asimi |

Ucu de ayni sinifin ornegidir: **zamanlayici aclugi (scheduler starvation)**,
urun kusuru degil.

## Neden bu bir "gevsetme" degil

`testTimeout` bir **dogrulama** esigi degildir:

* Hicbir iddia (assertion) degismez.
* Hicbir adim atlanmaz.
* Hicbir kripto/parola maliyeti dusurulmez.
* Yavaslayan bir uc HALA yakalanir — 30 sn gercek bir tavandir, sonsuz degil.

Bu paketlerin hicbiri **gecikme** olcmez; yetkilendirme, dogrulama ve durum
makinesi davranisi olcerler. Zamanlayici aclugunu "basarisizlik" diye
raporlamak, gercek gerilemeleri gurultunun icinde gizlerdi.

## Katmanlar

1. **Varsayilan — `package.json` > `jest.testTimeout` = 30 sn.**
   Paralel kosumdaki zamanlayici jitter'ini kapsar.

2. **Paket bazli yukseltme — `jest.setTimeout(60_000)`.**
   Yalnizca GERCEKTEN pahali islerde kullanilir ve dosyanin basinda NEDENI
   yazilir:
   * `twofactor-disable-authz.test.ts` — senaryo basina `bcrypt.hash(..., 10)`
     ve uctaki `bcrypt.compare`.
   * `webauthn-assertion-error-paths.test.ts` — gercek COSE ayristirma, PEM
     donusumu ve ECDSA/RSA imza dogrulamasi; tek `it` blogu onlarca anahtar
     sekli dener.

Yeni bir paket icin sure siniri yukseltmeden ONCE, isin gercekten pahali olup
olmadigi izole kosumla dogrulanmalidir. Izole kosumda da yavassa, sorun sure
siniri degildir.

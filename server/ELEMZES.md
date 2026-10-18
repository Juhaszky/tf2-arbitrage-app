# Arbitrázs-elemzés – a statisztikák értelmezése

Ez a leírás a `POST /api/arbitrage/analyze` végpontot magyarázza el: mit számol, hogyan olvasd az eredményt, és mikor érdemes megvenni egy tárgyat.

**Az elemzés alapelve:** a szerver akkor ajánl vételt, ha a tárgy **óvatos (pesszimista) becsléssel is nyereséges**, és a **múltbeli adatokon visszatesztelve is szinte mindig működött volna**. Inkább kihagy egy jó üzletet, mint hogy egy rosszat ajánljon.

A számítás az [src/services/arbitrage.service.ts](src/services/arbitrage.service.ts), a statisztikai segédfüggvények az [src/utils/stats.ts](src/utils/stats.ts) fájlban vannak. Ha ott változik a logika, ezt a leírást is frissíteni kell.

> ⚠️ **Fontos korlát:** a statisztika csökkenti a bukás esélyét, de nem zárja ki. Egy frissítés, egy hirtelen piaci esemény vagy egy manipulált ár olyan változást okozhat, amit a múltbeli adatok nem jeleznek előre. Soha ne fektess egy tárgyba annál többet, amennyit nyugodtan el tudsz veszíteni.

---

## Tartalom

1. [Gyors döntés](#1-gyors-döntés)
2. [Mit küldj be?](#2-mit-küldj-be)
3. [Hogyan számol a szerver?](#3-hogyan-számol-a-szerver)
4. [A válasz mezői](#4-a-válasz-mezői)
5. [Az ellenőrzések](#5-az-ellenőrzések)
6. [Beállítások](#6-beállítások)
7. [Gyakorlati tanácsok](#7-gyakorlati-tanácsok)

---

## 1. Gyors döntés

Nézd meg a válasz `recommendation` mezőjét:

| `recommendation` | Jelentés | Teendő |
|---|---|---|
| `BUY` | Minden ellenőrzés teljesült. | **Vedd meg**, de legfeljebb a `prices.maxBuyPrice` áron. Az eladást a `prices.targetSell` áron hirdesd meg. |
| `WATCH` | Átlagosan nyereséges, de valamelyik biztonsági feltétel nem teljesül. | **Ne vedd meg most.** A `checks` mezőből kiderül, mi hiányzik. Figyeld, és elemezd újra később. |
| `INSUFFICIENT_DATA` | Nincs elég, elég hosszú vagy elég friss adat a döntéshez. | **Ne vedd meg.** A `checks` mezőből kiderül, milyen adat hiányzik. |
| `AVOID` | Veszteséges, vagy a pesszimista becslés szerint az lehet. | **Ne vedd meg.** |

A `summary` mező egy mondatban, magyarul leírja az okot. Az `isWorthBuying` mező csak `BUY` esetén `true`.

---

## 2. Mit küldj be?

Egy tárgy (egy SKU) **teljes ártörténetét**, ahogy az adatforrás adja. Nem kell előre szűrni vagy rövidíteni: a szerver maga választja ki a szükséges időszakokat.

**Mennyi adat kell?** Az alapbeállításokkal legalább **30 nap** history, és az utolsó 90 napban legalább **5 árbejegyzés**. A legjobb eredményt **90 napnál hosszabb** history adja, mert a visszateszt 90 napot használ.

Három formátumot fogad el a szerver:

```jsonc
// 1) history tömb – az alapbeállításokkal
[ { ...bejegyzés... }, { ...bejegyzés... } ]

// 2) history + beállítások
{
  "history": [ { ...bejegyzés... } ],
  "options": { "keyPriceMetal": 60, "minMarginPercent": 15 }
}

// 3) egyetlen bejegyzés (erre mindig INSUFFICIENT_DATA lesz a válasz)
{ ...bejegyzés... }
```

Egy bejegyzés:

```json
{
  "name": "Team Captain",
  "sku": "378;6",
  "source": "bptf",
  "time": 1792199289,
  "buy":  { "keys": 1, "metal": 20.33 },
  "sell": { "keys": 1, "metal": 35 }
}
```

| Mező | Jelentés |
|---|---|
| `name`, `sku` | A tárgy neve és azonosítója. **Egy kérésben minden bejegyzés SKU-jának egyeznie kell**, különben 400-as hibát kapsz. |
| `source` | Az ár forrása. Az elemzés nem használja. |
| `time` | Unix időbélyeg (másodperc vagy ezredmásodperc, a szerver felismeri). A sorrend nem számít, a szerver rendezi. |
| `buy` | A felvásárlási ár: ennyiért tudod **megvenni** a tárgyat. |
| `sell` | Az eladási ár: ennyiért tudod **eladni** a tárgyat. |
| `keys`, `metal` | Az ár kulcsban és refined metalban. A `metal` elhagyható. |

**Metal átváltása:** a szerver minden árat kulcsra vált (`keys + metal / kulcsár`). A kulcsárat ebben a sorrendben keresi:

1. **A kérésben megadott fix érték** (`options.keyPriceMetal`).
2. **A gyűjtő által letöltött kulcsár-history** (lásd [GYUJTO.md](GYUJTO.md)). Ez a legpontosabb: minden bejegyzést a **saját korabeli** kulcsárával vált át. A kulcs eladási ára egy év alatt kb. 53 és 68 ref között mozgott, így a régi árak egyetlen mai kulcsárral átváltva akár 10–15%-kal is torzulnának.
3. **A `.env` fájlban megadott `KEY_PRICE_METAL`** (lásd [.env.example](.env.example)). Ez csak tartalék arra az esetre, ha a gyűjtő még nem futott.

Ha egyik sincs meg, de az árakban metal is szerepel, a szerver 400-as hibát ad, és nem számol hibás árral. A válasz `keyPrice` mezője megmutatja, melyik forrást használta (`history`, `fixed` vagy `none`), és mennyi most a kulcs ára.

Fix kulcsár esetén a szerver azt is ellenőrzi, hogy a kulcsár nem túl alacsony-e. Egy árban a metal rész mindig kevesebb egy kulcsnál (különben +1 kulcsként szerepelne). Ha tehát az adatokban `8k+64` szerepel, a kulcs legalább 64 refet ér. Ha a megadott kulcsár ennél kevesebb, a szerver 400-as hibát ad, mert az átváltás összekeverné az árak sorrendjét: 60-as kulcsárral például a `8k+64` drágábbnak látszana, mint a `9k+0.11`.

---

## 3. Hogyan számol a szerver?

### 3.1 A history mint lépcsős idősor
Egy bejegyzés azt jelenti, hogy **ettől az időponttól ez az ár érvényes**, egészen a következő bejegyzésig. Az utolsó ár mostanáig érvényes. Ha az ár három hétig nem változott, arra az időre nincs bejegyzés, de az ár ettől még érvényes volt.

A szerver ebből a lépcsős görbéből **óránként mintát vesz**, és minden statisztikát ezekből a mintákból számol. Így minden ár **annyi ideig számít, ameddig érvényes volt**: egy 2 órás kiugrás 2 órányi, egy 3 hetes árszint 3 hétnyi súllyal. Ez akkor is helyes, ha a forrás rendszeres pillanatképeket ad.

### 3.2 Két időszak

| Időszak | Alapérték | Mire használja |
|---|---|---|
| **Elemzési ablak** (`windowDays`) | utolsó 30 nap | Árszint (medián, percentilisek), ingadozás, trend. A régebbi árak már nem mondanak sokat a mai piacról. |
| **Visszateszt-időszak** (`backtestDays`) | utolsó 90 nap | Visszateszt (3.6 pont) és forgalom. Ide több adat kell, hogy a nyerési arány megbízható legyen. |

### 3.3 Kiugró értékek kiszűrése
Egy-egy elírt vagy manipulált ár (például egy 1 kulcsos tárgy rövid ideig 9 kulcsért) elrontaná a statisztikát. A szerver ezért minden bejegyzést a **szomszédos 3–3 bejegyzéshez** hasonlít (Hampel-szűrő), robusztus z-értékkel. Ha az ár 3,5 robusztus szórásnál messzebb van a szomszédok mediánjától, kiugrónak számít.

**Csak a kedvező irányú kiugrókat szűri ki:** a gyanúsan *olcsó vételi* és a gyanúsan *drága eladási* árat. Ezek hamis reményt adnának. A kedvezőtlen irányú kiugrók (hirtelen drága vétel, hirtelen olcsó eladás) bent maradnak, mert a valóságban is előfordulhatnak, és ezek jelentik a kockázatot.

További részletek:
- **Tartós árváltozás nem kiugró.** Mivel a szűrő csak a szomszédokat nézi, ha például egy hónapja feljebb ment az ár, és ott is maradt, az nem számít kiugrónak, csak a rövid, elszigetelt tüske.
- **A szórásnak minimuma van (a medián 2%-a).** Hosszan szinte változatlan ár mellett a robusztus szórás közel 0 lenne, és már egy pár százalékos, valódi mozgás is „kiugrónak” látszana. Ilyen például, amikor valaki újra és újra beteszi és visszavonja a vételi ajánlatát.
- **A legutolsó 3 bejegyzést soha nem szűri ki.** Egy friss áresés nem zaj, hanem valódi kockázat.

### 3.4 Átlag helyett medián és kvantilisek
A számtani átlagot egyetlen extrém érték is elhúzza, a medián (a középső érték) erre érzéketlen. A szerver ezért mediánnal és kvantilisekkel számol:

- **25. percentilis (P25):** az idő 25%-ában volt ennél alacsonyabb az ár. Óvatos eladási árként használja.
- **75. percentilis (P75):** az idő 75%-ában volt ennél alacsonyabb az ár. Óvatos vételi árként használja.

### 3.5 Trend (Theil–Sen becslés)
Megmutatja, hogyan változik az eladási ár az elemzési ablakban. A szerver minden mintapárra kiszámolja a meredekséget (napi árváltozást), és ezek mediánját veszi. Ez a kiugró értékekre sokkal kevésbé érzékeny, mint a hagyományos lineáris regresszió.

### 3.6 Óvatos (pesszimista) becslés
Ez az elemzés lényege. A szerver feltételezi, hogy a tárgyat drágábban veszed, mint általában, és olcsóbban adod el:

```
jelenlegi ár           = a legutolsó bejegyzés ára
óvatos vételi ár       = max( P75 vételi ár, jelenlegi vételi ár )
várható eladási ár     = jelenlegi eladási ár + (napi esés × tartási napok)   ← csak csökkenő trendnél
óvatos eladási ár      = min( P25 eladási ár, várható eladási ár ) × (1 − díj)
óvatos haszon          = óvatos eladási ár − óvatos vételi ár
óvatos haszonkulcs     = óvatos haszon / óvatos vételi ár × 100
```

Ha a tárgy ezzel a borúlátó számítással is nyereséges, kicsi az esélye, hogy bukni fogsz rajta.

### 3.7 Visszateszt
A szerver a visszateszt-időszak minden órájára megnézi: *ha akkor megvettem volna a vételi áron, és a tartási idő (`holdingDays`, alapból 3 nap) alatti eladási árak **alsó negyedén (P25)** adtam volna el, nyertem volna-e?* Csak azok a vételek számítanak, amelyeknél a teljes tartási idő látszik az adatokban.

A P25 pesszimista: feltételezi, hogy a tartási idő rosszabb részében adod el a tárgyat. Az abszolút legrosszabb pillanattal szemben viszont egy pár órás árhiba (például egyetlen pillanatképen egy irreálisan olcsó eladási ár) nem dönti el egyedül 3 napnyi ügylet sorsát. Egy tartós esés viszont igen.

- **`backtestWinRatePercent`:** az időszak hány százalékában lett volna nyereséges a vétel.
- **`backtestIndependentTrades`:** az egymás utáni órák ügyletei átfedik egymást, ezért nem függetlenek. A megbízhatóság számításához a szerver csak annyi ügyletet vesz, ahány **nem átfedő** tartási idő belefér az időszakba. 90 nap és 3 napos tartás esetén ez kb. 29–30.
- **`backtestWinRateLowerBoundPercent`:** a nyerési arány **alsó konfidenciahatára** (Wilson-módszer) a független ügyletszámmal. A valódi nyerési arány 90% valószínűséggel nem rosszabb ennél. 30 hibátlan ügyletből például 94,8% igazolható, 6-ból csak 78,5%.
- **`backtestWorstReturnPercent`:** a legrosszabb ügylet hozama.

### 3.8 Forgalom
Az eladási sebességet abból becsli, hogy a visszateszt-időszakban naponta átlagosan hány árbejegyzés van. Ez csak **közelítés**. Ha a forrás csak árváltozáskor ír bejegyzést, egy nagyon stabil árú tárgy is ritkán frissülhet, attól még kelendő lehet.

---

## 4. A válasz mezői

```jsonc
{
  "sku": "378;6",
  "itemName": "Team Captain",
  "recommendation": "BUY",
  "isWorthBuying": true,
  "riskLevel": "LOW",
  "summary": "Minden ellenőrzés teljesült: ...",
  "prices":  { ... },
  "profit":  { ... },
  "risk":    { ... },
  "data":    { ... },
  "checks":  [ ... ],
  "settings": { ... }
}
```

### `riskLevel`

| Érték | Mikor |
|---|---|
| `LOW` | `BUY`: minden ellenőrzés teljesült. |
| `MEDIUM` | `WATCH`, és csak a haszon küszöbei nem teljesülnek: a tárgy stabil, de a haszon kicsi. |
| `HIGH` | Minden más eset: ingadozó, csökkenő árú vagy rosszul visszatesztelt tárgy, kevés adat vagy `AVOID`. |

### `prices` – árak (kulcsban)

| Mező | Jelentés |
|---|---|
| `currentBuyKeys`, `currentSellKeys` | Jelenlegi vételi és eladási ár (a legutolsó bejegyzés ára). |
| `medianBuyKeys`, `medianSellKeys` | Időarányos tipikus vételi és eladási ár az elemzési ablakban. |
| `conservativeBuyKeys` | Óvatos vételi ár (3.6 pont). |
| `conservativeSellNetKeys` | Óvatos eladási ár, a díj levonása után. |
| **`maxBuyPriceKeys`**, **`maxBuyPrice`** | **Ennél többet ne fizess.** Ezen az áron még teljesül a minimális haszonkulcs és a minimális haszon. Ha megadtad a kulcs árát, a `maxBuyPrice` kulcs + metal formában is megjelenik, a metal lefelé kerekítve scrapre. |
| **`targetSellKeys`**, **`targetSell`** | Javasolt eladási ár: a jelenlegi és a medián eladási ár közül az alacsonyabb, hogy a tárgy valóban elkeljen. |

A `maxBuyPrice` akkor is hasznos, ha az ajánlás nem `BUY`: megmutatja, milyen áron érné meg mégis a vétel (például ha valaki olcsóbban kínálja).

### `profit` – haszon

| Mező | Jelentés |
|---|---|
| `expectedProfitKeys`, `expectedMarginPercent` | Haszon a tipikus (medián) árakkal. Ez a „normál” eset. |
| `conservativeProfitKeys`, `conservativeMarginPercent` | Haszon az óvatos becsléssel. **A döntés ezen alapul.** |

### `risk` – kockázat

| Mező | Jelentés | Jó érték |
|---|---|---|
| `volatilityPercent` | Az eladási ár robusztus ingadozása a mediánhoz képest. | alacsony (≤ 15%) |
| `sellTrendPercentPerWeek` | Az eladási ár heti változása. Negatív érték csökkenést jelent. | ≥ −5% |
| `backtestIndependentTrades` | Független (nem átfedő) visszatesztelt ügyletek száma. | minél több |
| `backtestWinRatePercent` | Az időszak hány százalékában lett volna nyereséges a vétel. | ≥ 90% |
| `backtestWinRateLowerBoundPercent` | A nyerési arány, amely 90%-os biztonsággal igazolható. | ≥ 90% |
| `backtestWorstReturnPercent` | A legrosszabb múltbeli ügylet hozama. | pozitív |

### `data` – az adatok minősége

| Mező | Jelentés |
|---|---|
| `pointsReceived` | Beküldött bejegyzések száma. |
| `historyDays` | Ennyi napot fed le a history (az első bejegyzéstől mostanáig). |
| `backtestPeriodDays` | A visszateszt-időszak hossza napokban (legfeljebb `backtestDays`). |
| `changesInPeriod` | Árbejegyzések száma a visszateszt-időszakban, kiugrók nélkül. |
| `outliersRemoved` | Kiszűrt kiugró bejegyzések száma. Ha sok, gyanús az adatforrás. |
| `dataAgeHours` | A legutolsó bejegyzés ennyi órás. |
| `updatesPerDay` | Napi árbejegyzések száma (a forgalom közelítése). |
| `estimatedSaleSpeed` | `FAST`: legalább napi 1. `NORMAL`: legalább `minUpdatesPerDay`. `SLOW`: ennél kevesebb. |

### `checks` és `settings`
- `checks`: minden ellenőrzés eredménye (lásd lent), az elért értékkel, a küszöbbel és egy magyar nyelvű üzenettel.
- `settings`: a ténylegesen használt beállítások, így utólag is látszik, milyen szigorral futott az elemzés.

---

## 5. Az ellenőrzések

`BUY` akkor lesz az eredmény, ha **mind a tizenegy** ellenőrzés teljesül.

| Azonosító | Kategória | Feltétel (alapértékkel) | Miért fontos |
|---|---|---|---|
| `DATA_POINTS` | adat | legalább 5 árbejegyzés az utolsó 90 napban | Ha az ár hónapokig nem frissült, nem tudni, mennyit ér ma valójában. |
| `HISTORY_SPAN` | adat | a history legalább 30 napot fed le | Rövid időszakon a trend és az ingadozás nem mérhető. |
| `FRESHNESS` | adat | a legutolsó bejegyzés legfeljebb 72 órás | Régi adatból nem lehet a mai árra következtetni. |
| `BACKTEST_SAMPLE` | adat | legalább 15 független visszatesztelt ügylet | Kevés ügyletnél a nyerési arány nem megbízható. |
| `CONSERVATIVE_MARGIN` | haszon | óvatos haszonkulcs legalább 10% | Ennyi tartalék kell a váratlan árváltozásokra. |
| `CONSERVATIVE_PROFIT` | haszon | óvatos haszon legalább 0,05 kulcs | Az apró haszon nem éri meg a cserével járó időt és kockázatot. |
| `WIN_RATE` | kockázat | a visszatesztben az időszak legalább 90%-ában nyereséges | A múltban is működött-e a stratégia. |
| `WIN_RATE_CONFIDENCE` | kockázat | ha a nyerési arány elég magas, az alsó konfidenciahatára is legalább 90% | A 93%-os nyerési arány 30 ügyletből még nem bizonyítja meggyőzően, hogy a valódi arány 90% fölött van. Csak akkor bukik el, ha a nyers arány jónak látszik. |
| `VOLATILITY` | kockázat | ingadozás legfeljebb 15% | Erősen ingadozó árú tárgynál a haszon esetleges. |
| `TREND` | kockázat | heti esés legfeljebb 5% | Csökkenő árú tárgyon ülve elfogyhat a haszon. |
| `LIQUIDITY` | kockázat | legalább napi 0,1 árbejegyzés (kb. 10 naponta egy) | A ritkán mozgó árú tárgy jellemzően rosszabbul forog, és sokáig a nyakadon maradhat. |
| `SALE_SPEED` | kockázat | a tényleges (mannco.store) eladások alapján egy darab legfeljebb 14 nap alatt elkel | Csak ha van párosított mannco tárgy. A sebesség a 90 napos eladásokból számít, ha abban legalább 5 volt, különben az éves adatból. Ha egy éve nem volt eladás, elbukik. |
| `SPREAD_SANITY` | kockázat | a medián eladási ár legfeljebb 200%-kal a medián vételi ár fölött | Ennél nagyobb árrés szinte mindig irreális hirdetésből adódik (pl. 9999 kulcsos eladási ár), nem valódi lehetőség. |

### Hogyan születik az ajánlás

A szerver a szabályokat ebben a sorrendben vizsgálja, és az első teljesülőnél megáll:

1. **`AVOID`**, ha a tipikus haszon ≤ 0, **vagy** az óvatos haszon ≤ 0, **vagy** (legalább 15 független ügylet mellett) a nyerési arány 50% alatt van.
2. **`INSUFFICIENT_DATA`**, ha bármelyik *adat* kategóriájú ellenőrzés elbukik.
3. **`BUY`**, ha minden ellenőrzés teljesül.
4. **`WATCH`** minden más esetben.

### Eladási sebesség (`sales`)

A pricedb csak a hirdetési árak history-ját adja, a tényleges eladásokat nem. Ha a tárgy párosítható a mannco.store-ral, a szerver letölti a mannco eladásait (egy év, napi bontás, tárgyanként naponta egyszer), és ebből becsüli, mennyi idő alatt kel el egy darab (1 / napi eladás). Ez a backpack.tf-es eladásnak is a legjobb elérhető közelítése.

- A `SALE_SPEED` ellenőrzés elbukik, ha a becsült eladási idő `maxDaysToSell`-nél hosszabb.
- **A tartási idő a becsült eladási időhöz igazodik.** Ha egy tárgy 10 nap alatt kel el, az óvatos eladási ár és a visszateszt 10 napos áreséssel számol, nem a fix 3 nappal. A visszateszt-időszak ilyenkor hosszabb, így a lassan eladható tárgyaknál gyakrabban lesz `INSUFFICIENT_DATA` az eredmény.
- A válasz `sales` mezője tartalmazza az eladásszámokat (30, 90, 365 nap), az utolsó eladás idejét, a darabonkénti medián árat és a becsült eladási időt; a `data.holdingDays` és a `data.backtestDays` a ténylegesen használt értékeket.

### Vétel mannco.store-on (`alternative`, `bestRoute`)

Ha a tárgy a mannco.store-on is kapható (és be van állítva a `MANNCO_API_KEY`), a szerver egy második útvonalat is értékel: **vétel azonnal a legolcsóbb mannco ajánlatból, eladás backpack.tf-en**. A mannco ár USD-ben van, ezt a mannco saját kulcsárával váltja kulcsra, mert a dollárt ott tudnád kulcsra váltani.

Ugyanaz a logika dönt, ugyanazokkal a küszöbökkel:

- **Az eladási oldal ellenőrzései** változatlanul érvényesek: `DATA_POINTS`, `HISTORY_SPAN`, `FRESHNESS`, `BACKTEST_SAMPLE`, `VOLATILITY`, `TREND`, `LIQUIDITY`, `SPREAD_SANITY`.
- **A haszon** az óvatos backpack.tf eladási ár mínusz a mannco ár (`CONSERVATIVE_MARGIN`, `CONSERVATIVE_PROFIT`). A vételi ár itt ismert és azonnal teljesül, ezért nincs szükség óvatos vételi becslésre.
- **A visszateszt** (`WIN_RATE`, `WIN_RATE_CONFIDENCE`) azt méri, hogy az elmúlt időszakban az idő hány százalékában lehetett volna a tartási időn belül a mannco ár fölött eladni.
- **`STOCK`** (adat): legalább 1 darab elérhető a mannco-n.
- **`PRICE_SANITY`** (kockázat): a mannco ár legalább a backpack.tf medián vételi ár 50%-a. Az ennél sokkal olcsóbb ajánlat szinte mindig eltérő változat (festék, spell, más effekt) vagy rossz párosítás.

A válaszban az `alternative` mező tartalmazza a mannco útvonal ajánlását, árát, készletét, linkjét és ellenőrzéseit. A `bestRoute` mutatja a jobb útvonalat: a vételre ajánlott közül a nagyobb óvatos hasznút, különben a jobb ajánlásút. Az `isWorthBuying` akkor igaz, ha **bármelyik** útvonalon `BUY` az ajánlás. A frontend lista, a szűrők és a Discord értesítések a `bestRoute` szerint működnek.

---

## 6. Beállítások

Minden küszöb állítható a kérés `options` mezőjében. Csak nemnegatív szám adható meg, a hibás értékre a szerver 400-as hibát ad.

| Beállítás | Alapérték | Leírás |
|---|---|---|
| `keyPriceMetal` | – (`KEY_PRICE_METAL`) | Egy kulcs ára refined metalban. |
| `sellFeePercent` | 0 (`SELL_FEE_PERCENT`) | Eladáskor levont díj. Közvetlen cserénél 0, piactérnél add meg a jutalékot. |
| `windowDays` | 30 | Elemzési ablak: árszint, ingadozás, trend. |
| `backtestDays` | 90 | Visszateszt-időszak. Hosszabb időszak több független ügyletet és megbízhatóbb nyerési arányt ad. |
| `maxDataAgeHours` | 72 | A legutolsó bejegyzés legnagyobb megengedett kora. |
| `minPoints` | 5 | Minimális árbejegyzés-szám a visszateszt-időszakban. |
| `minHistoryDays` | 30 | Minimális history-hossz napokban. |
| `holdingDays` | 3 | Ennyi idő alatt számolsz a továbbadással. Rosszul forgó tárgynál növeld. Ilyenkor kevesebb lesz a független ügylet, ezért a `backtestDays` értékét is érdemes növelni. |
| `minMarginPercent` | 10 | Minimális óvatos haszonkulcs. |
| `minProfitKeys` | 0.05 | Minimális óvatos haszon kulcsban. |
| `maxVolatilityPercent` | 15 | Megengedett ingadozás. |
| `maxDownTrendPercentPerWeek` | 5 | Megengedett heti áresés. |
| `minWinRatePercent` | 90 | Minimális visszateszt-nyerési arány (a nyers arányra és az alsó konfidenciahatárra is). |
| `minBacktestTrades` | 15 | Minimális független visszatesztelt ügyletszám. |
| `minUpdatesPerDay` | 0.1 | Minimális napi árbejegyzés-szám. |
| `maxDaysToSell` | 14 | A becsült eladási idő felső határa napban. A tartási idő is ehhez igazodik: legalább `holdingDays`, legfeljebb ennyi nap, a visszateszt-időszak pedig legalább a tartási idő 15-szöröse, hogy maradjon elég független ügylet. |
| `maxSpreadPercent` | 200 | A medián eladási ár legfeljebb ennyi százalékkal lehet a medián vételi ár fölött. |

Ha a fentinél is biztonságosabb ajánlásokat szeretnél (kevesebb, de még megbízhatóbb `BUY`), például ezekkel a beállításokkal:

```json
{ "minMarginPercent": 15, "minWinRatePercent": 95, "maxVolatilityPercent": 10, "backtestDays": 180 }
```

Ha egy tárgyat várhatóan csak lassan tudsz eladni, a tartási idővel együtt a visszateszt-időszakot is növeld, hogy maradjon elég független ügylet:

```json
{ "holdingDays": 7, "backtestDays": 210 }
```

---

## 7. Gyakorlati tanácsok

- **Ne fizess többet a `maxBuyPrice`-nál.** Ha drágábban veszed meg a tárgyat, az óvatos becslés már nem érvényes rá.
- **Árazz reálisan.** A `targetSell` szándékosan nem a legmagasabb ár. Ha mohón árazol, a tárgy nem kel el, és közben eshet az ára.
- **Oszd meg a pénzed.** Inkább több különböző `BUY` tárgyat vegyél kisebb tételben, mint egyet nagyban. Egy váratlan árzuhanás így csak a pénzed kis részét érinti.
- **Elemezd újra eladás előtt.** Ha közben `AVOID` lett az eredmény (például zuhan az ár), érdemes előbb eladni, kisebb haszonnal.
- **Figyelj az `outliersRemoved` értékre.** Ha sok bejegyzést szűrt ki a szerver, az adatforrásban hamis vagy manipulált árak lehetnek.
- **Frissítsd a kulcs árát.** A `KEY_PRICE_METAL` értékét tartsd naprakészen: elavult kulcsárral a metal alapú árak átváltása hibás lesz.
- **Tudd, mit nem lát az elemzés:** a tárgy egyedi tulajdonságait (paint, strange part, unusual effect), a játékfrissítéseket és a valódi eladási darabszámot.

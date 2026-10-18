# Automatikus adatgyűjtés (pricedb.io)

A szerver indulás után egy időzített gyűjtőt (cron) futtat. Ez minden futáskor a [pricedb.io](https://pricedb.io) teljes árlistájából (kb. 52 000 tárgy) kiválasztja a vételre esélyes tárgyakat. Ezek ár-történetét letölti, elmenti, elemzi, és az eredményt haszon szerint csökkenő sorrendben adja vissza. Az elemzés értelmezéséről az [ELEMZES.md](ELEMZES.md) szól.

A kód az [src/collector/](src/collector/) és az [src/market/](src/market/) mappában van, a pricedb.io kliens az [src/clients/pricedb.client.ts](src/clients/pricedb.client.ts) fájlban.

---

## Beállítás

Alapból a teljes piacot figyeli, ehhez nem kell semmit megadni. A beállítások a `.env` fájlban vannak, a teljes lista az [.env.example](.env.example) fájlban található.

> ⚠️ A `.env` változása után **újra kell indítani a szervert**. A `npm run dev` csak a kód változását figyeli, a `.env`-ét nem.

| Változó | Alapérték | Jelentés |
|---|---|---|
| `MANNCO_API_KEY` | – | mannco.store API kulcs (a fiókod beállításaiban hozható létre). Nélküle a mannco útvonal kimarad. |
| `MANNCO_BID_REQUESTS_PER_RUN` | 30 | Futásonként legfeljebb ennyi tömeges árazó kérés a mannco buy orderekhez (kérésenként 100 tárgy; a mannco percenként 10-et enged, így 30 kérés kb. 3,3 perc). |
| `MAX_CANDIDATES` | 150 | Az előszűrés után vételi útvonalanként (backpack.tf, mannco.store) legfeljebb ennyi tárgy kap teljes elemzést. |
| `SCREEN_SNAPSHOT_DAYS` | 7 | Az előszűrés ennyi napi pillanatképen nézi, hogy az árrés tartós-e. |
| `COLLECT_CRON` | `*/30 * * * *` | Milyen gyakran fusson a gyűjtő (cron kifejezés: perc, óra, nap, hónap, hét napja). |
| `HISTORY_REFRESH_MINUTES` | 120 | Egy SKU history-ját csak akkor kérdezi le újra, ha ennyi perce nem frissült. A pricedb.io nagyjából 2 óránként frissít, ennél gyakrabban felesleges. |
| `MAX_SKUS_PER_RUN` | 200 | Egy futásban legfeljebb ennyi history-t kérdez le. A többi a következő futásra marad. |
| `REQUEST_DELAY_MS` | 1000 | Szünet két kérés között ezredmásodpercben (+ legfeljebb 50% véletlen). |
| `ITEMS_REFRESH_HOURS` | 24 | A tárgylista (a keresőhöz) frissítési gyakorisága. |
| `COLLECT_ON_STARTUP` | `true` | Induláskor azonnal fusson-e egy gyűjtés. |
| `COLLECTOR_ENABLED` | `true` | `false` értékkel a gyűjtő kikapcsol. |
| `DATA_DIR` | `./data` | Hova mentse az adatokat. |
| `PRICEDB_BASE_URL` | `https://pricedb.io/api` | Az API címe. |

Az előszűrés ugyanazokkal a haszonküszöbökkel dolgozik, mint az elemzés (`SELL_FEE_PERCENT` és az elemzés alapértékei).

---

## Hogyan működik egy futás

1. **Árlista:** egyetlen kéréssel letölti minden tárgy aktuális árát (`/api/autob/items`, kb. 8 MB), és a lista saját kulcsárával kulcsra váltja.
   - **mannco.store:** ha van `MANNCO_API_KEY`, letölti a mannco teljes TF2 árlistáját is (`/item/prices`, kb. 85 000 sor, 17 MB; a mannco 5 percenként egy ilyen kérést enged). A tárgyakat név szerint párosítja a pricedb tárgyakkal. A mannco az unusual effektet külön mezőben adja, a nevek elé gyakran `The`-t tesz, és a nem craftolható tárgyat jelzővel jelöli, ezért a párosítás a név szavainak rendezett halmazán és a craftolhatóságon alapul. Ugyanannak a tárgynak több sora is lehet (árszintek, festett vagy spelles példányok); a legolcsóbbat használja, mert az a sima változat. A pricedb-n többértelmű neveket (pl. azonos nevű, eltérő tartalmú kit fabricatorok) kihagyja. A dolláros árakat a mannco saját kulcsárával váltja kulcsra.
2. **Előszűrés, 1. lépcső – pontos szűrő:** csak azok a tárgyak maradnak, amelyeknek friss az ára (`maxDataAgeHours`), és a vétel–eladás különbség a díj levonása után eléri a minimális haszonkulcsot és hasznot. Ez nem hagy ki vételi lehetőséget, mert az elemzés óvatos becslése sosem jobb a jelenlegi árrésnél. Két vételi útvonalat néz: a backpack.tf vételi árat és a mannco ajánlatot; az eladás mindkét esetben backpack.tf-en történik. Kiesnek az irreális árrésű tárgyak (az eladási ár több mint háromszorosa a vételinek), és a gyanúsan olcsó mannco ajánlatok (a backpack.tf vételi ár fele alatt).
3. **Előszűrés, 2. lépcső – tartósság:** az előző napok éjféli (UTC) pillanatképei (`/api/snapshot/{időpont}`) közül mindegyikben meg kellett lennie az árrésnek, és az árnak legalább 4 különböző időpontban frissülnie kellett. Így esnek ki a ritka tárgyak, amelyeknél a nagy árrés csak elavult hirdetésekből adódik. A múltbeli pillanatképet csak egyszer tölti le, utána naponta egy új kérés kell.
4. **Szűrő:** ha a frontenden ár (kulcs, -tól -ig) vagy típus (Strange, Unusual, Genuine stb.) szerinti szűrőt állítottál be, csak a megfelelő tárgyak maradnak. Az ár a jelenlegi vételi ár. A típust az SKU adja: a második tag a minőség, a `;strange` tag pedig a Strange típushoz is besorolja a tárgyat (pl. Strange Unusual). A szűrő mentése új gyűjtést indít.
5. **Rangsor:** a megmaradt tárgyakat útvonalanként a legrosszabb esetbeli haszon (a pillanatképek közül a legkisebb, kulcsban) szerint rendezi, és mindkét útvonal első `MAX_CANDIDATES` tárgya teljes elemzést kap. A mannco vételek ritkábbak és kisebb hasznúak, ezért közös rangsorban sosem kerülnének be.
6. **Kulcsár:** a kulcs (`5021;6`) history-ját mindig frissíti, ha esedékes. Az elemzés ebből váltja át a metal árakat kulcsra.
7. **History letöltése:** a jelöltek, a külön értesítésre jelölt tárgyak és a legutóbb vételre ajánlottak közül az esedékeseket kérdezi le az `/api/item-history/{sku}` végpontról: a legrégebben frissítettel kezdve, legfeljebb `MAX_SKUS_PER_RUN` darabot, két kérés között `REQUEST_DELAY_MS` szünettel. Az új history-t összefésüli a korábban mentettel, így a régi adat akkor sem vész el, ha a forrás egyszer rövidebb history-t adna.
8. **Elemzés:** mindegyiket elemzi mindkét útvonalon (lásd [ELEMZES.md](ELEMZES.md#vétel-manncostore-on-alternative-bestroute)), és a legjobb útvonal óvatos haszna (kulcs) szerint csökkenő sorrendbe rendezi. Az első, hosszabb futás alatt 25 letöltésenként részeredményt is ment, így a felület hamar mutat valamit. Az elemzések között a szerver visszaadja a vezérlést, így az API közben is válaszol.
9. **Értesítés:** ha egy tárgy vételre vált vagy már nem az, és kérsz rá értesítést, Discord üzenetet küld.

**Védelmek:**
- **Átfedés ellen:** ha egy futás még tart, a következő kimarad.
- **Rate limit:** a pricedb.io percenként 360 kérést enged. Ha a keret majdnem elfogyott, vagy a szerver 429-es választ ad, a gyűjtő a `Retry-After` / `RateLimit-Reset` fejléc szerint vár, majd újrapróbálja.
- **Hálózati és 5xx hibák:** legfeljebb 4 próbálkozás, növekvő várakozással.
- **Hibás SKU:** egy SKU hibája nem állítja le a futást, a hibát a státusz mutatja.
- **Elérhetetlen árlista:** ha az árlista letöltése nem sikerül, a legutóbbi előszűrés jelöltjeivel megy tovább.

**Példa:** az első futás kb. 160 kérés (árlista, 7 pillanatkép, kulcs, 150 history), ez kb. 3–4 perc. Utána futásonként 1 árlista-kérés és az esedékes history-k (a 150 jelölt kétóránként egyszer), illetve naponta 1 új pillanatkép.

## Azonnali üzletek (mannco.store ↔ backpack.tf)

Ha be van állítva a `MANNCO_API_KEY`, minden futás végén a szerver tartás nélküli üzleteket is keres. Ezekben a vétel és az eladás azonnal vagy rövid időn belül megtörténik:

| Típus | Vétel | Eladás |
|---|---|---|
| mannco vétel → bptf quicksell | a mannco legolcsóbb ajánlata | a backpack.tf botoknak a buy order árukon (pricedb `buy`) |
| mannco buy order → bptf quicksell | saját mannco buy order **reális áron** (lásd lent) | a backpack.tf botoknak a buy order árukon |
| bptf vétel → mannco buy order | a backpack.tf botoktól az eladási árukon (pricedb `sell`) | a legmagasabb mannco buy ordernek, 5% díjjal |

A dollárt mindenhol a mannco kulcsárával váltja kulcsra. Egy üzlet akkor kerül a listára, ha a jelenlegi árakkal eléri a minimális hasznot és haszonkulcsot. Akkor **ajánlott**, ha minden ellenőrzés teljesül, különben „Figyeld”:

- **`PERSISTENCE`:** a backpack.tf láb legrosszabb ára az elmúlt napok napi pillanatképeiben is hasznot hagy.
- **`BPTF_FRESHNESS`:** a backpack.tf ár legfeljebb 24 órás.
- **`BPTF_ACTIVITY`:** a backpack.tf ár a pillanatképek alatt legalább 4 különböző időpontban frissült. A ritkán frissülő ár inkább becslés.
- **`UNUSUAL_PRICE`:** unusualnál mindig elbukik, mert a pricedb unusual árai becsült értékek, és a botok ritkán kereskednek velük ezen az áron.
- **`MANNCO_FRESHNESS`:** a mannco buy order adat legfeljebb 6 órás.
- **`PRICE_SANITY`:** a két piac ára legfeljebb kétszeres eltérésű. Ennél nagyobb eltérés szinte mindig eltérő változat (festék, spell, effekt) vagy rossz párosítás.
- **`FILL_TIME`** (csak saját buy ordernél): a javasolt áron a buy order legfeljebb `maxDaysToSell` nap alatt teljesülhet.

**A saját buy order ára** nem egyszerűen 1 centtel a legmagasabb buy order fölött van, mert ha azon az áron senki sem ad el, a buy order sosem teljesül. Az ár a mannco tényleges eladásaiból jön (90 nap; kevés eladásnál egy év). Aki az időszakban egy adott áron vagy olcsóbban eladta a tárgyat, az a buy ordered is teljesítette volna. A teljesülési idő ezért ≈ az időszak hossza osztva az ennyiért vagy olcsóbban eladott darabok számával. A javasolt ár a legalacsonyabb olyan ár, amelynél ez legfeljebb `maxDaysToSell` nap. Alsó határ a legmagasabb buy order + 1 cent; felső határ az az ár, ahol még megvan a minimális haszon, és amely olcsóbb a legolcsóbb ajánlatnál (különben inkább azt vennéd meg). Ha a nyereséges tartományban nincs ilyen ár, az üzlet „Figyeld”, a legmagasabb még nyereséges ár becsült teljesülési idejével. A mannco napi átlagárat ad, ezért ez közelítés.

**Buy order adatok:** a legmagasabb mannco buy ordert a tömeges árazó adja (`/item/pricing/bulk`; a `lowest_buy_order` mező a neve ellenére a legmagasabb buy order). Percenként csak kb. 1000 tárgyra kérhető le, ezért futásonként `MANNCO_BID_REQUESTS_PER_RUN` kéréssel, prioritás szerint frissül: elöl a legutóbb talált üzletek és a mannco ajánlat alapján ígéretes tárgyak, a többi a legrégebben frissítettel kezdve. Egy órán belül frissített adatot nem kér le újra. A nem készleten lévő tárgyak azonosítóit naponta egyszer, a háttérben tölti le (`outofstock=1`, 5 perccel az árlista után, mert a mannco 5 percenként csak egy árlista-kérést enged).

**Értesítés:** ha egy tárgyra kérsz értesítést (vagy be van kapcsolva az „Értesítés minden új vételi lehetőségről”), egy új ajánlott üzletről egyszer szól Discordon. Ha az üzlet eltűnik, majd újra megjelenik, újra szól.

## Értesítések

- **Összefoglaló minden keresés után** (frontend: „Összefoglaló értesítés az új vételi lehetőségekről”, API: `PUT /api/notifications/settings { "notifyAllBuys": true }`). Minden futás végén egyetlen Discord üzenet megy az *újonnan* talált vételi lehetőségekről: a hosszabb távú elemzés „Vétel” tárgyairól (📈) és az ajánlott azonnali üzletekről (⚡). Haszon szerint csökkenő sorrendben jönnek, a legjobb 10 részletesen: hol vedd → hol add el, ár, haszon, becsült eladási vagy teljesülési idő, linkek. Unusualnál figyelmeztetés is szerepel, mert a pricedb ára ott becsült érték. Amiről már szólt, arról addig nem szól újra, amíg el nem tűnik a lehetőségek közül. Bekapcsoláskor a következő keresés a már meglévő lehetőségekről is szól. A beállított ár- és típusszűrő érvényes rá, a tárgyanként kikapcsolt tárgyak kimaradnak.
- **Tárgyankénti, részletes üzenet** (a kártyák „Értesítés” kapcsolója): a megjelölt tárgyakról külön üzenet megy, amikor vételre váltanak, már nem ajánlottak, vagy új ajánlott azonnali üzlet jelenik meg rájuk.

Az állapot a `data/scan-digest.json` (miről szólt már az összefoglaló), a `data/notifications.json` és a `data/deals-notified.json` fájlban van.

---

## Végpontok

| Végpont | Leírás |
|---|---|
| `GET /api/market` | Az elemzett tárgyak óvatos haszon szerint csökkenő sorrendben, az előszűrés összesítőjével és az értesítési beállításokkal. Ezt használja a frontend. |
| `GET /api/deals` | Az azonnali üzletek (ajánlottak elöl, haszon szerint csökkenő sorrendben), a mostani szűrővel, tárgyanként az értesítési beállítással és a buy order adatok lefedettségével. |
| `PUT /api/market/filter` | `{ "minKeys": 1, "maxKeys": 20, "qualities": ["strange", "unusual"] }`: vételi ár (kulcs) és típus szerinti szűrő. A `null` határ és az üres lista nem szűr. Választható típusok: `unique`, `strange`, `unusual`, `genuine`, `vintage`, `haunted`, `collectors`, `decorated`, `selfmade`, `normal`. |
| `PUT /api/notifications/items/{sku}` | `{ "notify": true }` vagy `false`: értesítés ki/be egy tárgyra. A bekapcsolt tárgyat akkor is elemzi, ha kiesik az előszűrésen. |
| `PUT /api/notifications/settings` | `{ "notifyAllBuys": true }` vagy `false`: értesítés minden tárgyról, amelyik vételre vált. A tárgyankénti kikapcsolás felülírja. |
| `GET /api/notifications/status` | A Discord beállítás és az értesítési beállítások. |
| `GET /api/arbitrage/tracked` | A legutóbbi elemzés nyers eredménye, haszon szerint csökkenő sorrendben. A `?recommendation=BUY` szűrővel csak a megadott ajánlásúakat adja vissza. |
| `GET /api/arbitrage/tracked/{sku}` | Egy SKU friss elemzése a mentett history-ból. Az elemzési beállítások query paraméterként adhatók meg, például `?minMarginPercent=15&holdingDays=7`. Az SKU-t URL-kódolva add meg: `722;11` → `722%3B11`. |
| `GET /api/collector/status` | A gyűjtő állapota: fut-e, a legutóbbi futás eredménye (az előszűrés számaival), és SKU-nként az utolsó letöltés ideje, illetve hibája. |
| `POST /api/collector/run` | Azonnali gyűjtés a háttérben. |
| `POST /api/arbitrage/analyze` | Kézi elemzés tetszőleges beküldött history-ra (lásd [ELEMZES.md](ELEMZES.md)). |

---

## Mentett adatok (`DATA_DIR`)

| Fájl | Tartalom |
|---|---|
| `items.json` | A pricedb.io tárgylistája. |
| `history/{sku}.json` | SKU-nként az összefésült history. A fájlnévben az SKU URL-kódolva szerepel, például `722%3B11.json`. |
| `state.json` | SKU-nként az utolsó lekérdezés ideje, a bejegyzések száma és az esetleges hiba. |
| `analysis.json` | A legutóbbi elemzés minden elemzett SKU-ra. |
| `market-filter.json` | A frontenden beállított ár- és típusszűrő. |
| `mannco-offers.json` | A legutóbbi mannco árlista a pricedb tárgyakhoz párosítva (SKU → legolcsóbb ajánlat), és a mannco kulcsár. |
| `mannco-catalog.json` | A nem készleten lévő mannco tárgyak azonosítói (URL, numerikus azonosító) a pricedb SKU-khoz párosítva; naponta frissül. |
| `mannco-sales.json` | Tárgyanként a mannco eladási statisztika (30, 90, 365 napos eladásszám, becsült eladási idő); naponta frissül. |
| `mannco-bids.json` | Tárgyanként a legmagasabb mannco buy order, a legolcsóbb ajánlat és az utolsó eladás. |
| `deals.json` | A legutóbb talált azonnali üzletek. |
| `deals-notified.json` | Mely üzletekről ment már értesítés. |
| `mannco-session.json` | A mannco bejelentkezési token (JWT, kb. 31 napig érvényes, a bejelentkezéskori IP-hez kötött). Lejáratkor vagy elutasításkor automatikusan újat kér. |
| `screen.json` | A legutóbbi előszűrés: a számok és a jelöltek listája. |
| `snapshots/{időpont}.json` | A napi pillanatképek tömören (SKU → vétel, eladás kulcsban, időpont). A régieket automatikusan törli. |
| `notification-settings.json` | Az értesítési beállítások (általános és tárgyankénti). Az első induláskor a korábbi `tracked.json` tárgyait veszi át. |
| `notifications.json` | SKU-nként az utoljára látott ajánlás, mert csak a változásról megy értesítés. |

A `data` mappa törölhető: a következő futás mindent újra letölt.

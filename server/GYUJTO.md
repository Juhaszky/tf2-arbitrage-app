# Automatikus adatgyűjtés (pricedb.io)

A szerver indulás után egy időzített gyűjtőt (cron) futtat. Ez a [pricedb.io](https://pricedb.io) API-ból rendszeresen letölti a követett tárgyak ár-történetét, elmenti, és lefuttatja rajtuk az elemzést. Az elemzés értelmezéséről az [ELEMZES.md](ELEMZES.md) szól.

A kód az [src/collector/](src/collector/) mappában van, a pricedb.io kliens az [src/clients/pricedb.client.ts](src/clients/pricedb.client.ts) fájlban.

---

## Beállítás

A `.env` fájlban add meg a követendő tárgyak SKU-it. A teljes lista az [.env.example](.env.example) fájlban van.

```env
TRACKED_SKUS=["722;11","40;11;kt-3"]
```

Az SKU-kat a `https://pricedb.io/api/items` listából (vagy a pricedb.io / backpack.tf oldaláról) veheted. JSON tömbként és vesszővel elválasztott listaként (`722;11,40;11;kt-3`) is megadhatod őket.

> ⚠️ A `.env` változása után **újra kell indítani a szervert**. A `npm run dev` csak a kód változását figyeli, a `.env`-ét nem.

| Változó | Alapérték | Jelentés |
|---|---|---|
| `TRACKED_SKUS` | – | A követett tárgyak SKU-i. |
| `COLLECT_CRON` | `*/30 * * * *` | Milyen gyakran fusson a gyűjtő (cron kifejezés: perc, óra, nap, hónap, hét napja). |
| `HISTORY_REFRESH_MINUTES` | 120 | Egy SKU-t csak akkor kérdez le újra, ha ennyi perce nem frissült. A pricedb.io nagyjából 2 óránként frissít, ennél gyakrabban felesleges. |
| `MAX_SKUS_PER_RUN` | 20 | Egy futásban legfeljebb ennyi SKU-t kérdez le. A többi a következő futásra marad. |
| `REQUEST_DELAY_MS` | 3000 | Szünet két kérés között ezredmásodpercben (+ legfeljebb 50% véletlen). |
| `ITEMS_REFRESH_HOURS` | 24 | A tárgylista frissítési gyakorisága. |
| `COLLECT_ON_STARTUP` | `true` | Induláskor azonnal fusson-e egy gyűjtés. |
| `COLLECTOR_ENABLED` | `true` | `false` értékkel a gyűjtő kikapcsol. |
| `DATA_DIR` | `./data` | Hova mentse az adatokat. |
| `PRICEDB_BASE_URL` | `https://pricedb.io/api` | Az API címe. |

---

## Hogyan működik egy futás

1. **Tárgylista:** naponta egyszer letölti az `/api/items` listát (kb. 52 000 tárgy). Ebből ellenőrzi, hogy a `TRACKED_SKUS`-ban megadott SKU-k léteznek-e. Az ismeretlen SKU-kat kihagyja, és nem küld rájuk kérést.
2. **Kulcsár:** a kulcs (`5021;6`) history-ját mindig frissíti, ha esedékes. Az elemzés ebből váltja át a metal árakat kulcsra.
3. **Esedékes SKU-k kiválasztása:** csak azokat kérdezi le, amelyeket `HISTORY_REFRESH_MINUTES` óta nem frissített, a legrégebben frissítettel kezdve, legfeljebb `MAX_SKUS_PER_RUN` darabot.
4. **Letöltés késleltetéssel:** az SKU-kat egymás után kérdezi le az `/api/item-history/{sku}` végpontról, két kérés között `REQUEST_DELAY_MS` szünettel.
5. **Összefésülés:** az új history-t időbélyeg szerint összefésüli a korábban mentettel. Így ha a forrás egyszer csak rövidebb history-t adna, a régi adat akkor sem vész el.
6. **Elemzés:** a végén minden követett SKU-t újraelemez. Az eredmény a legjobb ajánlatokkal kezdődik (`BUY`, majd `WATCH`, `INSUFFICIENT_DATA`, `AVOID`; azon belül az óvatos haszonkulcs szerint csökkenő sorrendben).

**Védelmek:**
- **Átfedés ellen:** ha egy futás még tart, a következő kimarad.
- **Rate limit:** a pricedb.io percenként 360 kérést enged. Ha a keret majdnem elfogyott, vagy a szerver 429-es választ ad, a gyűjtő a `Retry-After` / `RateLimit-Reset` fejléc szerint vár, majd újrapróbálja.
- **Hálózati és 5xx hibák:** legfeljebb 4 próbálkozás, növekvő várakozással.
- **Hibás SKU:** egy SKU hibája nem állítja le a futást, a hibát a státusz mutatja.

**Példa:** 100 követett SKU, 30 perces cron, 120 perces frissítés és 20 SKU/futás esetén minden SKU kb. 2,5 óránként frissül. Futásonként legfeljebb 21 kérés megy ki, kb. 1–1,5 perc alatt.

---

## Végpontok

| Végpont | Leírás |
|---|---|
| `GET /api/arbitrage/tracked` | A követett SKU-k legutóbbi elemzése, a legjobb ajánlatokkal kezdve. |
| `GET /api/arbitrage/tracked?recommendation=BUY` | Csak a megadott ajánlású tárgyak (`BUY`, `WATCH`, `INSUFFICIENT_DATA`, `AVOID`). |
| `GET /api/arbitrage/tracked/{sku}` | Egy SKU friss elemzése a mentett history-ból. Az elemzési beállítások query paraméterként adhatók meg, például `?minMarginPercent=15&holdingDays=7`. Az SKU-t URL-kódolva add meg: `722;11` → `722%3B11`. |
| `GET /api/collector/status` | A gyűjtő állapota: fut-e, a legutóbbi futás eredménye, és SKU-nként az utolsó letöltés ideje, illetve hibája. |
| `POST /api/collector/run` | Azonnali gyűjtés a háttérben. Csak az esedékes SKU-kat kérdezi le. |
| `POST /api/arbitrage/analyze` | Kézi elemzés tetszőleges beküldött history-ra (lásd [ELEMZES.md](ELEMZES.md)). |

---

## Mentett adatok (`DATA_DIR`)

| Fájl | Tartalom |
|---|---|
| `items.json` | A pricedb.io tárgylistája. |
| `history/{sku}.json` | SKU-nként az összefésült history. A fájlnévben az SKU URL-kódolva szerepel, például `722%3B11.json`. |
| `state.json` | SKU-nként az utolsó lekérdezés ideje, a bejegyzések száma és az esetleges hiba. |
| `analysis.json` | A legutóbbi elemzés minden követett SKU-ra. |

A `data` mappa törölhető: a következő futás mindent újra letölt.

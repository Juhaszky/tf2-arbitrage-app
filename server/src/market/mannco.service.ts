import { ManncoClient, ManncoPriceRow, ManncoSalesDay } from '../clients/mannco.client';
import { KEY_SKU, config } from '../config';
import { AlternativeBuy, HistoryEntry, SalesInfo } from '../services/arbitrage.service';
import { FileStore } from '../storage/file.store';
import { ManncoOffer, indexManncoOffers, manncoKey, pricedbKey } from './mannco.matcher';

export interface ManncoOffersFile {
  fetchedAt: string;
  /** A kulcs legolcsóbb mannco ára centben; ezzel váltjuk kulcsra a dolláros árakat. */
  keyPriceCents: number;
  /** A mannco árlista sorainak száma. */
  rows: number;
  /** pricedb SKU → a legolcsóbb mannco ajánlat (csak az egyértelműen párosítható, készleten lévő tárgyak). */
  offers: Record<string, ManncoOffer>;
}

/** Egy mannco tárgy azonosítói: az URL (eladási history-hoz) és a numerikus azonosító (árazáshoz). */
interface CatalogEntry {
  url: string;
  itemId: number;
}

/** A nem készleten lévő tárgyak mannco azonosítói, hogy az eladási history-juk és a buy ordereik is lekérhetők legyenek. */
interface CatalogFile {
  fetchedAt: string;
  slugs: Record<string, CatalogEntry>;
}

/** Egy tárgy legmagasabb mannco buy ordere és a hozzá tartozó árak (centben). */
export interface ManncoBid {
  itemId: number;
  /** A legmagasabb buy order (0, ha nincs). */
  bidCents: number;
  lowestSaleCents: number | null;
  lastSaleCents: number | null;
  lastSaleAt: string | null;
  fetchedAt: string;
}

/** Egy eladásos nap: [a nap kezdete (ms), darabszám, darabonkénti átlagár (cent)]. */
type SalesDay = [t: number, count: number, unitCents: number];

interface SalesEntry {
  fetchedAt: string;
  slug: string;
  stats: Omit<SalesInfo, 'source' | 'label'>;
  /** Az elmúlt év eladásos napjai (a reális buy order ár becsléséhez). */
  days?: SalesDay[];
}

/** Reális buy order ár a tényleges eladásokból. */
export interface OrderFillEstimate {
  priceCents: number;
  /** Becsült idő a teljesülésig napban; null, ha az időszakban ennyiért vagy olcsóbban nem kelt el darab. */
  fillDays: number | null;
  /** Ennyi darab kelt el az időszakban ezen az áron vagy olcsóbban. */
  soldAtOrBelow: number;
  windowDays: number;
  /** Elérte-e a célzott teljesülési időt (ha nem, ez a legmagasabb még nyereséges ár). */
  reachedTarget: boolean;
}

const FILE = 'mannco-offers.json';
const CATALOG_FILE = 'mannco-catalog.json';
const SALES_FILE = 'mannco-sales.json';
const BIDS_FILE = 'mannco-bids.json';
/** A buy order adatot ennél frissebben nem kérjük le újra (a mannco maga is 5–20 percig gyorsítótárazza). */
const BID_REFRESH_MS = 60 * 60_000;
/** A mannco 5 percenként egy árlista-kérést enged. */
const MIN_LIST_INTERVAL_MS = 5 * 60_000 + 5_000;
const CATALOG_MAX_AGE_MS = 24 * 3_600_000;
/** A napi eladási adatok naponta változnak, ezért tárgyanként naponta egyszer kérjük le. */
const SALES_MAX_AGE_MS = 24 * 3_600_000;
/** Ennyi eladás kell a 90 napos időszakban, hogy abból becsüljük a sebességet; különben az éves adatból. */
const MIN_SALES_FOR_90_DAYS = 5;
const STORE_URL = 'https://mannco.store/item/';
const DAY_MS = 86_400_000;

/**
 * A mannco.store adatai a pricedb tárgyakhoz párosítva:
 * - ajánlatok: futásonként a teljes TF2 árlista (`/item/prices`), a legolcsóbb ajánlattal és készlettel;
 * - katalógus: naponta egyszer a nem készleten lévő tárgyak listája is (`outofstock=1`), hogy minden tárgynak
 *   meglegyen a mannco azonosítója;
 * - eladások: az elemzett tárgyak tényleges eladásai (`/item/salesGraph`, egy év, napi bontás), naponta frissítve;
 * - buy orderek: a legmagasabb mannco buy order (`/item/pricing/bulk`), prioritás szerint, forgó sorrendben frissítve.
 * A párosítás név szerint történik (lásd mannco.matcher); a pricedb-n többértelmű neveket kihagyja.
 */
export class ManncoService {
  private cache?: ManncoOffersFile | null;
  private catalog?: CatalogFile | null;
  private sales?: Record<string, SalesEntry>;
  private bids?: Record<string, ManncoBid>;
  private lastListFetchAt = 0;
  private catalogTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private store = new FileStore(config.dataDir),
    private client = new ManncoClient(config.manncoApiKey, store),
  ) {}

  get isConfigured() {
    return this.client.isConfigured;
  }

  /** Friss ajánlatok a pricedb tárgyaihoz; hiba esetén a legutóbb mentettet adja (vagy null-t). */
  async refresh(pricelist: HistoryEntry[]): Promise<ManncoOffersFile | null> {
    if (!this.isConfigured) return null;
    if (Date.now() - this.lastListFetchAt < MIN_LIST_INTERVAL_MS) return this.get();
    try {
      this.lastListFetchAt = Date.now();
      const rows = await this.client.getPrices();
      const index = indexManncoOffers(rows);
      const key = index.get(pricedbKey(KEY_SKU, 'Mann Co. Supply Crate Key'));
      if (!key) throw new Error('A mannco árlistájában nincs kulcs, így nem lehet kulcsra váltani az árakat.');

      const file: ManncoOffersFile = {
        fetchedAt: new Date().toISOString(),
        keyPriceCents: key.priceCents,
        rows: rows.length,
        offers: matchToPricedb(index, pricelist),
      };
      await this.store.write(FILE, file, false);
      this.cache = file;
      console.log(
        `[mannco] Árlista: ${rows.length} sor, ${Object.keys(file.offers).length} pricedb tárgy párosítva, ` +
        `kulcs ${(key.priceCents / 100).toFixed(2)} $.`,
      );
      await this.scheduleCatalogRefresh(pricelist);
      return file;
    } catch (error) {
      console.warn(`[mannco] Az árlista frissítése sikertelen, a korábbit használjuk: ${(error as Error).message}`);
      return this.get();
    }
  }

  async get(): Promise<ManncoOffersFile | null> {
    if (this.cache === undefined) this.cache = await this.store.read<ManncoOffersFile | null>(FILE, null);
    return this.cache;
  }

  /** A tárgy mannco ajánlata az elemzés számára (kulcsra váltva), vagy undefined, ha nincs. */
  async alternativeFor(sku: string): Promise<AlternativeBuy | undefined> {
    const file = await this.get();
    const offer = file?.offers[sku];
    if (!file || !offer) return undefined;
    return toAlternative(offer, file.keyPriceCents);
  }

  /** A tárgy tényleges mannco eladásai, vagy undefined, ha nincs párosítható mannco tárgy (vagy még nincs letöltve). */
  async salesFor(sku: string): Promise<SalesInfo | undefined> {
    const entry = (await this.getSales())[sku];
    return entry ? { source: 'mannco', label: 'mannco.store', ...entry.stats } : undefined;
  }

  /**
   * A megadott tárgyak eladási adatainak frissítése (csak a régebben, mint egy napja frissítetteké).
   * Visszaadja a sikeres lekérések számát.
   */
  async refreshSales(skus: string[]): Promise<number> {
    if (!this.isConfigured) return 0;
    const sales = await this.getSales();
    let fetched = 0;
    for (const sku of skus) {
      const slug = await this.slugFor(sku);
      if (!slug) continue;
      const existing = sales[sku];
      const fresh = !!existing?.days && existing.slug === slug && Date.now() - Date.parse(existing.fetchedAt) < SALES_MAX_AGE_MS;
      if (fresh) continue;
      try {
        const days = await this.client.getSalesGraph(slug, '1Y');
        sales[sku] = { fetchedAt: new Date().toISOString(), slug, stats: salesStats(days), days: salesDays(days) };
        fetched++;
      } catch (error) {
        console.warn(`[mannco] ${sku} eladási adatainak letöltése sikertelen: ${(error as Error).message}`);
      }
    }
    if (fetched > 0) await this.store.write(SALES_FILE, sales, false);
    return fetched;
  }

  /** A tárgy napi mannco eladásai az elmúlt évből: [nap kezdete (ms), darab, darabár (cent)]. */
  async salesDaysFor(sku: string): Promise<SalesDay[] | undefined> {
    return (await this.getSales())[sku]?.days;
  }

  /** Megvannak-e a tárgy napi eladási adatai (a reális buy order árhoz). */
  async hasSalesDays(sku: string) {
    return !!(await this.getSales())[sku]?.days;
  }

  /**
   * Reális buy order ár a tényleges eladásokból: a legalacsonyabb ár `minCents` és `maxCents` között, amelynél a
   * becsült teljesülési idő legfeljebb `targetDays`. A becslés: aki az időszakban ennyiért vagy olcsóbban adta el
   * a tárgyat, az a buy ordered is teljesítette volna, így a teljesülési sebesség ezeknek az eladásoknak a száma
   * osztva az időszak hosszával. (A napi adat átlagár, ezért ez közelítés.) Ha a célidő a tartományban nem érhető
   * el, a `maxCents` áron mért becslést adja (`reachedTarget: false`); ha nincs napi eladási adat, undefined-ot.
   */
  async orderFill(sku: string, minCents: number, maxCents: number, targetDays: number): Promise<OrderFillEstimate | undefined> {
    const entry = (await this.getSales())[sku];
    if (!entry?.days || maxCents < minCents) return undefined;
    const windowDays = entry.stats.windowDays;
    const cutoff = Date.now() - windowDays * DAY_MS;
    const days = entry.days.filter(([t]) => t >= cutoff);
    const soldAtOrBelow = (price: number) => days.reduce((sum, [, count, unit]) => sum + (unit <= price ? count : 0), 0);
    const estimate = (price: number, reachedTarget: boolean): OrderFillEstimate => {
      const sold = soldAtOrBelow(price);
      return { priceCents: price, fillDays: sold > 0 ? windowDays / sold : null, soldAtOrBelow: sold, windowDays, reachedTarget };
    };

    const prices = [...new Set([minCents, ...days.map(([, , unit]) => Math.ceil(unit))])]
      .filter((p) => p >= minCents && p <= maxCents)
      .sort((a, b) => a - b);
    for (const price of prices) {
      const sold = soldAtOrBelow(price);
      if (sold > 0 && windowDays / sold <= targetDays) return estimate(price, true);
    }
    return estimate(maxCents, false);
  }

  /** A tárgy legutóbb lekért legmagasabb mannco buy ordere. */
  async bidFor(sku: string): Promise<ManncoBid | undefined> {
    return (await this.getBids())[sku];
  }

  /**
   * Buy order adatok frissítése a megadott sorrendben (az elején a legfontosabbak), legfeljebb `maxRequests`
   * tömeges kéréssel (kérésenként 100 tárgy; a mannco percenként 10-et enged). Csak az egy óránál régebbi
   * adatot kéri le újra. Visszaadja a frissített tárgyak számát.
   */
  async refreshBids(skus: string[], maxRequests: number): Promise<number> {
    if (!this.isConfigured || maxRequests <= 0) return 0;
    const bids = await this.getBids();
    const due: { sku: string; itemId: number }[] = [];
    for (const sku of new Set(skus)) {
      const existing = bids[sku];
      if (existing && Date.now() - Date.parse(existing.fetchedAt) < BID_REFRESH_MS) continue;
      const itemId = (await this.idsFor(sku))?.itemId;
      if (itemId) due.push({ sku, itemId });
      if (due.length >= maxRequests * 100) break;
    }

    let updated = 0;
    for (let i = 0; i < due.length; i += 100) {
      const chunk = due.slice(i, i + 100);
      try {
        const items = await this.client.getBulkPricing([...new Set(chunk.map((c) => c.itemId))]);
        const byId = new Map(items.map((it) => [it.item_id, it]));
        const now = new Date().toISOString();
        for (const { sku, itemId } of chunk) {
          const p = byId.get(itemId)?.pricing;
          if (!p) continue;
          bids[sku] = {
            itemId,
            bidCents: p.lowest_buy_order ?? 0,
            lowestSaleCents: p.lowest_sale_price || null,
            lastSaleCents: p.last_sale?.price ?? null,
            lastSaleAt: p.last_sale?.date ? new Date(p.last_sale.date * 1000).toISOString() : null,
            fetchedAt: now,
          };
          updated++;
        }
      } catch (error) {
        console.warn(`[mannco] Buy order adatok letöltése sikertelen: ${(error as Error).message}`);
        break;
      }
    }
    if (updated > 0) await this.store.write(BIDS_FILE, bids, false);
    return updated;
  }

  /** A pricedb tárgy mannco azonosítói: a készleten lévők az ajánlatból, a többi a katalógusból. */
  async idsFor(sku: string): Promise<CatalogEntry | undefined> {
    const offer = (await this.get())?.offers[sku];
    if (offer) return { url: offer.url, itemId: offer.itemId };
    this.catalog ??= await this.store.read<CatalogFile | null>(CATALOG_FILE, null);
    return this.catalog?.slugs[sku];
  }

  /** Van-e párosított mannco tárgy (készleten vagy a katalógusban). */
  async hasItem(sku: string) {
    return !!(await this.idsFor(sku));
  }

  private async slugFor(sku: string): Promise<string | undefined> {
    return (await this.idsFor(sku))?.url;
  }

  private async getBids() {
    this.bids ??= await this.store.read<Record<string, ManncoBid>>(BIDS_FILE, {});
    return this.bids;
  }

  private async getSales() {
    this.sales ??= await this.store.read<Record<string, SalesEntry>>(SALES_FILE, {});
    return this.sales;
  }

  /**
   * A nem készleten lévő tárgyak listája naponta egyszer kell. Mivel a mannco 5 percenként csak egy árlista-kérést
   * enged, az ajánlatok letöltése után a háttérben, 5 perccel később kérjük le.
   */
  private async scheduleCatalogRefresh(pricelist: HistoryEntry[]) {
    this.catalog ??= await this.store.read<CatalogFile | null>(CATALOG_FILE, null);
    const fresh = this.catalog && Date.now() - Date.parse(this.catalog.fetchedAt) < CATALOG_MAX_AGE_MS;
    if (fresh || this.catalogTimer) return;
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = undefined;
      void this.refreshCatalog(pricelist);
    }, MIN_LIST_INTERVAL_MS);
  }

  private async refreshCatalog(pricelist: HistoryEntry[]) {
    try {
      this.lastListFetchAt = Date.now();
      const rows = await this.client.getPrices(true);
      const index = new Map<string, CatalogEntry>();
      for (const row of rows) {
        const k = manncoKey(row as ManncoPriceRow);
        if (row?.url && row.item_id && !index.has(k)) index.set(k, { url: row.url, itemId: row.item_id });
      }
      this.catalog = { fetchedAt: new Date().toISOString(), slugs: matchToPricedb(index, pricelist) };
      await this.store.write(CATALOG_FILE, this.catalog, false);
      console.log(`[mannco] Katalógus: ${rows.length} nem készleten lévő tárgy, ${Object.keys(this.catalog.slugs).length} párosítva.`);
    } catch (error) {
      console.warn(`[mannco] A katalógus frissítése sikertelen: ${(error as Error).message}`);
    }
  }
}

/**
 * Mannco név-kulcs → érték párosítása a pricedb SKU-khoz. Azonos név csak akkor párosítható, ha az SKU-k
 * csak a tagok sorrendjében térnek el (pl. war paint duplikátumok); az eltérő tartalmú, azonos nevűek kimaradnak.
 */
function matchToPricedb<T>(index: Map<string, T>, pricelist: HistoryEntry[]): Record<string, T> {
  const skusByKey = new Map<string, string[]>();
  for (const e of pricelist) {
    const k = pricedbKey(e.sku, e.name);
    skusByKey.set(k, [...(skusByKey.get(k) ?? []), e.sku]);
  }
  const result: Record<string, T> = {};
  for (const [k, skus] of skusByKey) {
    const value = index.get(k);
    if (value === undefined) continue;
    if (new Set(skus.map((s) => s.split(';').sort().join(';'))).size > 1) continue;
    for (const sku of skus) result[sku] = value;
  }
  return result;
}

/**
 * Eladási statisztika a napi eladásokból. A mannco csak az eladásos napokat adja vissza, a `price` a napi
 * összbevétel (centben), az `nb` a darabszám. A sebesség a 90 napos időszakból számít, ha abban legalább
 * MIN_SALES_FOR_90_DAYS eladás volt, különben az éves adatból (ritka tárgyaknál így megbízhatóbb).
 */
export function salesStats(days: ManncoSalesDay[], now = Date.now()): SalesEntry['stats'] {
  const valid = days
    .map((d) => ({ t: Date.parse(`${String(d.date).slice(0, 10)}T00:00:00Z`), nb: Number(d.nb) || 0, total: Number(d.price) || 0 }))
    .filter((d) => Number.isFinite(d.t) && d.nb > 0);
  const within = (n: number) => valid.filter((d) => now - d.t <= n * DAY_MS);
  const count = (list: typeof valid) => list.reduce((sum, d) => sum + d.nb, 0);
  const sales30 = count(within(30));
  const sales90 = count(within(90));
  const sales365 = count(within(365));

  const windowDays = sales90 >= MIN_SALES_FOR_90_DAYS ? 90 : 365;
  const salesPerDay = (windowDays === 90 ? sales90 : sales365) / windowDays;

  const unitPrices = within(windowDays).map((d) => d.total / d.nb / 100).sort((a, b) => a - b);
  const medianUnitPrice = unitPrices.length > 0 ? unitPrices[Math.floor(unitPrices.length / 2)] : null;
  const last = valid.reduce((max, d) => Math.max(max, d.t), 0);

  return {
    sales30,
    sales90,
    sales365,
    lastSaleAt: last ? new Date(last).toISOString() : null,
    salesPerDay: parseFloat(salesPerDay.toFixed(4)),
    windowDays,
    expectedDaysToSell: salesPerDay > 0 ? 1 / salesPerDay : null,
    medianUnitPrice: medianUnitPrice === null ? null : parseFloat(medianUnitPrice.toFixed(2)),
    currency: 'USD',
  };
}

/** Az elmúlt év eladásos napjai tömören (darabonkénti átlagár centben). */
function salesDays(days: ManncoSalesDay[], now = Date.now()): SalesDay[] {
  return days
    .map((d): SalesDay => {
      const count = Number(d.nb) || 0;
      return [Date.parse(`${String(d.date).slice(0, 10)}T00:00:00Z`), count, count > 0 ? Math.round((Number(d.price) || 0) / count) : 0];
    })
    .filter(([t, count, unit]) => Number.isFinite(t) && count > 0 && unit > 0 && now - t <= 365 * DAY_MS)
    .sort((a, b) => a[0] - b[0]);
}

export const toAlternative = (offer: ManncoOffer, keyPriceCents: number): AlternativeBuy => ({
  source: 'mannco',
  label: 'mannco.store',
  buyKeys: offer.priceCents / keyPriceCents,
  price: offer.priceCents / 100,
  currency: 'USD',
  stock: offer.stock,
  url: STORE_URL + offer.url,
});

export const manncoService = new ManncoService();

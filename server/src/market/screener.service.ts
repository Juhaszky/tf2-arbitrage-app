import { PriceDbClient } from '../clients/pricedb.client';
import { KEY_SKU, config, envAnalysisOptions } from '../config';
import { DEFAULT_OPTIONS, HistoryEntry } from '../services/arbitrage.service';
import { FileStore } from '../storage/file.store';
import { MarketFilter, filterService, matchesFilter } from './filter.service';
import { manncoService } from './mannco.service';

/** Egy tárgy ára kulcsban egy időpontban: [vétel, eladás, a bejegyzés ideje (mp)]. */
export type Quote = [buy: number, sell: number, time: number];
export type Quotes = Record<string, Quote>;

/** A legutóbbi előszűrés nyers adatai (memóriában), hogy más számítások ne kérjék le újra. */
export interface ScreenContext {
  at: number;
  current: Quotes;
  snapshots: { ts: number; quotes: Quotes }[];
  names: Map<string, string>;
}

/** Honnan vennéd: backpack.tf vételi ajánlattal, vagy azonnal a mannco.store legolcsóbb ajánlatából. */
export type BuyRoute = 'bptf' | 'mannco';

export interface Candidate {
  sku: string;
  name: string;
  /** A jobb (nagyobb legrosszabb esetbeli hasznú) vételi útvonal; az eladás mindig backpack.tf-en. */
  route: BuyRoute;
  buyKeys: number;
  sellKeys: number;
  /** A jelenlegi árakkal, az eladási díj levonása után. */
  profitKeys: number;
  marginPercent: number;
  /** A legkisebb haszon a jelenlegi ár és a napi pillanatképek közül; ez szerint rangsorolunk. */
  worstProfitKeys: number;
}

export interface ScreenResult {
  screenedAt: string;
  keyPriceMetal: number;
  /** Ennyi tárgy szerepelt az árlistában. */
  scanned: number;
  /** Ennyinél van meg most, friss áron a minimális haszon (a szűrőnek megfelelők közül). */
  profitableNow: number;
  /** A szűrő, amellyel az előszűrés készült. */
  filter: MarketFilter;
  /** Ennyinél minden pillanatképben megvolt, és az ára többször is frissült. */
  persistent: number;
  /** mannco.store: a párosított, készleten lévő tárgyak száma, és hánynál nyereséges most a mannco vétel. Null, ha nincs beállítva. */
  mannco: { matched: number; profitableNow: number; keyPriceUsd: number } | null;
  snapshotsUsed: number;
  /** A teljes elemzésre kiválasztott tárgyak (útvonalanként a legjobb `maxCandidates`), a legrosszabb esetbeli haszon szerint csökkenő sorrendben. */
  candidates: Candidate[];
}

const DAY = 86400;
const SNAPSHOT_DIR = 'snapshots';
const FILE = 'screen.json';
/** Ennyi különböző időpontú árbejegyzés kell a jelenlegi árlistában és a pillanatképekben együtt (a forgalom közelítése). */
const MIN_DISTINCT_UPDATES = 4;
/** A mannco ár legalább a backpack.tf vételi ár ennyi része legyen (ugyanaz a küszöb, mint az elemzés PRICE_SANITY ellenőrzésében). */
const MIN_ALTERNATIVE_PRICE_RATIO = 0.5;

const round = (v: number, digits = 4) => parseFloat(v.toFixed(digits));

/**
 * Előszűrés a teljes piacon. Egyetlen kéréssel letölti minden tárgy aktuális árát, és kiválasztja azokat,
 * amelyeknél az elemzés egyáltalán adhat vételi ajánlást: friss az ár, és a vétel–eladás különbség eléri a
 * minimális haszonkulcsot és hasznot. Ez pontos szűrő, mert az elemzés óvatos becslése sosem jobb a
 * jelenlegi árrésnél. A rengeteg ritka tárgy közül azokat tartja meg, amelyeknél az árrés a napi
 * pillanatképekben is végig megvolt, és rangsorolja őket; a teljes, history alapú elemzés csak a legjobbakra fut.
 * Két vételi útvonalat néz: a backpack.tf vételi ajánlatot és (ha be van állítva) a mannco.store legolcsóbb
 * ajánlatát; az eladás mindkét esetben backpack.tf-en történik, így a pillanatképekben az eladási oldalnak kell tartósnak lennie.
 */
export class MarketScreener {
  private snapshotCache = new Map<number, Quotes>();
  /** A legutóbbi előszűrés árlistája és pillanatképei. */
  context?: ScreenContext;

  constructor(private client: PriceDbClient, private store = new FileStore(config.dataDir)) {}

  async screen(): Promise<ScreenResult> {
    const pricelist = await this.client.getPricelist();
    const { quotes: current, keyPriceMetal } = toQuotes(pricelist);
    const mannco = await manncoService.refresh(pricelist);
    const now = Date.now() / 1000;
    const snapshots = await this.loadSnapshots(now);
    const filter = await filterService.get();

    const opts = { ...DEFAULT_OPTIONS, ...envAnalysisOptions() };
    const fee = opts.sellFeePercent / 100;
    // Vételi ár útvonalanként: backpack.tf-en az adott időpont vételi ára, mannco-n a mostani fix ajánlat
    const buyOf = (q: Quote, alt: number | undefined) => alt ?? q[0];
    const profitOf = (q: Quote, alt?: number) => q[1] * (1 - fee) - buyOf(q, alt);
    const passes = (q: Quote | undefined, at: number, alt?: number): q is Quote => {
      if (!q || !(q[0] > 0) || !(q[1] > 0) || at - q[2] > opts.maxDataAgeHours * 3600) return false;
      // Irreális backpack.tf árrés (pl. 9999 kulcsos eladási hirdetés) és gyanúsan olcsó mannco ár kiszűrése
      if (q[1] > q[0] * (1 + opts.maxSpreadPercent / 100)) return false;
      if (alt !== undefined && alt < q[0] * MIN_ALTERNATIVE_PRICE_RATIO) return false;
      const buy = buyOf(q, alt);
      return profitOf(q, alt) >= opts.minProfitKeys && (profitOf(q, alt) / buy) * 100 >= opts.minMarginPercent;
    };

    const names = new Map(pricelist.map((e) => [e.sku, e.name]));
    this.context = { at: now, current, snapshots, names };
    let profitableNow = 0;
    let manncoProfitableNow = 0;
    // Útvonalanként külön rangsor: a mannco vételek ritkábbak és kisebb hasznúak, így a közös rangsorban
    // sosem kerülnének a jelöltek közé. Tárgyanként a jobb útvonal a „legjobb”.
    const persistent: Candidate[] = [];
    const byRoute: Record<BuyRoute, Candidate[]> = { bptf: [], mannco: [] };

    for (const [sku, quote] of Object.entries(current)) {
      if (sku === KEY_SKU) continue;
      const offer = mannco?.offers[sku];
      const routes: { route: BuyRoute; alt?: number }[] = [
        { route: 'bptf' as const },
        ...(offer && mannco ? [{ route: 'mannco' as const, alt: offer.priceCents / mannco.keyPriceCents }] : []),
      ].filter((r) => matchesFilter(filter, sku, buyOf(quote, r.alt)) && passes(quote, now, r.alt));
      if (routes.length === 0) continue;
      profitableNow++;
      if (routes.some((r) => r.route === 'mannco')) manncoProfitableNow++;

      const past = snapshots.map((s) => s.quotes[sku]);
      const all = [quote, ...(past as Quote[])];
      if (past.some((q) => !q) || new Set(all.map((q) => q[2])).size < Math.min(MIN_DISTINCT_UPDATES, all.length)) continue;

      let best: Candidate | undefined;
      for (const { route, alt } of routes) {
        if (!snapshots.every((s, i) => passes(past[i], s.ts, alt))) continue;
        const profit = profitOf(quote, alt);
        const buy = buyOf(quote, alt);
        const worst = Math.min(...all.map((q) => profitOf(q, alt)));
        const candidate: Candidate = {
          sku,
          name: names.get(sku) ?? sku,
          route,
          buyKeys: round(buy, 3),
          sellKeys: round(quote[1], 3),
          profitKeys: round(profit, 3),
          marginPercent: round((profit / buy) * 100, 1),
          worstProfitKeys: round(worst, 3),
        };
        byRoute[route].push(candidate);
        if (!best || worst > best.worstProfitKeys) best = candidate;
      }
      if (best) persistent.push(best);
    }

    // Mindkét útvonal legjobb `maxCandidates` tárgya bekerül; egy tárgy egyszer, a jobbik útvonalával
    const bestBySku = new Map(persistent.map((c) => [c.sku, c]));
    const chosen = new Set<string>();
    for (const list of Object.values(byRoute)) {
      list.sort((a, b) => b.worstProfitKeys - a.worstProfitKeys);
      for (const c of list.slice(0, config.market.maxCandidates)) chosen.add(c.sku);
    }
    const candidates = [...chosen].map((sku) => bestBySku.get(sku)!).sort((a, b) => b.worstProfitKeys - a.worstProfitKeys);
    const result: ScreenResult = {
      screenedAt: new Date().toISOString(),
      keyPriceMetal,
      scanned: pricelist.length,
      profitableNow,
      filter,
      persistent: persistent.length,
      mannco: mannco
        ? {
          matched: Object.keys(mannco.offers).length,
          profitableNow: manncoProfitableNow,
          keyPriceUsd: mannco.keyPriceCents / 100,
        }
        : null,
      snapshotsUsed: snapshots.length,
      candidates,
    };
    await this.store.write(FILE, result);
    return result;
  }

  getLastScreen() {
    return this.store.read<ScreenResult | null>(FILE, null);
  }

  /**
   * Az utolsó `snapshotDays` nap éjféli (UTC) pillanatképei. A múltbeli pillanatkép nem változik, ezért
   * mindegyiket csak egyszer töltjük le; naponta egy új kérés kell. A sikertelen letöltés kimarad.
   */
  private async loadSnapshots(now: number) {
    const today = Math.floor(now / DAY) * DAY;
    const wanted = Array.from({ length: config.market.snapshotDays }, (_, i) => today - i * DAY);
    const snapshots: { ts: number; quotes: Quotes }[] = [];

    for (const ts of wanted) {
      let quotes = this.snapshotCache.get(ts) ?? (await this.store.read<Quotes | null>(snapshotFile(ts), null));
      if (!quotes) {
        try {
          quotes = toQuotes(await this.client.getSnapshot(ts)).quotes;
          await this.store.write(snapshotFile(ts), quotes, false);
          console.log(`[screener] Pillanatkép letöltve: ${new Date(ts * 1000).toISOString().slice(0, 10)}`);
        } catch (error) {
          console.warn(`[screener] A(z) ${ts} pillanatkép letöltése sikertelen: ${(error as Error).message}`);
          continue;
        }
      }
      this.snapshotCache.set(ts, quotes);
      snapshots.push({ ts, quotes });
    }

    // A már nem használt pillanatképek törlése
    for (const name of await this.store.list(SNAPSHOT_DIR)) {
      const ts = Number(name.replace(/\.json$/, ''));
      if (!wanted.includes(ts)) await this.store.remove(`${SNAPSHOT_DIR}/${name}`);
    }
    for (const ts of this.snapshotCache.keys()) if (!wanted.includes(ts)) this.snapshotCache.delete(ts);

    return snapshots;
  }
}

const snapshotFile = (ts: number) => `${SNAPSHOT_DIR}/${ts}.json`;

/** Árlista → SKU-nként kulcsban kifejezett ár, a lista saját (egyidejű) kulcsárával átváltva. */
function toQuotes(entries: HistoryEntry[]) {
  if (!Array.isArray(entries)) throw new Error('A pricedb.io nem tömböt adott vissza.');
  const keyPriceMetal = entries.find((e) => e.sku === KEY_SKU)?.sell?.metal || envAnalysisOptions().keyPriceMetal;
  if (!keyPriceMetal) throw new Error('Az árlistában nincs kulcsár, és a KEY_PRICE_METAL sincs megadva.');

  const toKeys = (p: HistoryEntry['buy'] | undefined) => (p?.keys ?? 0) + (p?.metal ?? 0) / keyPriceMetal;
  const quotes: Quotes = {};
  for (const e of entries) {
    if (!e?.sku || typeof e.time !== 'number') continue;
    quotes[e.sku] = [round(toKeys(e.buy)), round(toKeys(e.sell)), e.time > 1e12 ? Math.round(e.time / 1000) : e.time];
  }
  return { quotes, keyPriceMetal };
}

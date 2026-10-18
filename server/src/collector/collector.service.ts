import { PriceDbClient, PriceDbItem } from '../clients/pricedb.client';
import { KEY_SKU, config, envAnalysisOptions } from '../config';
import { bptfStatsUrl, namesIndex } from '../market/bptf-link';
import { dealsService } from '../market/deals.service';
import { filterService } from '../market/filter.service';
import { sendScanDigest } from '../notifications/scan-digest';
import { manncoService } from '../market/mannco.service';
import { MarketScreener, ScreenResult } from '../market/screener.service';
import { notifyRecommendationChanges } from '../notifications/notifier';
import { preferencesService } from '../notifications/preferences.service';
import { ArbitrageService, HistoryEntry, KeyPricePoint } from '../services/arbitrage.service';
import { FileStore, historyFile } from '../storage/file.store';

export interface SkuState {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  entries?: number;
}

interface CollectorState {
  itemsFetchedAt?: number;
  skus: Record<string, SkuState>;
}

export interface RunSummary {
  reason: string;
  startedAt: string;
  finishedAt?: string;
  requests: number;
  /** Az előszűrés eredménye (null, ha az árlista letöltése nem sikerült, és a korábbit használtuk). */
  screen: Omit<ScreenResult, 'candidates'> & { candidates: number } | null;
  analyzed: number;
  /** Ennyi tárgy mannco eladási adatait töltöttük le (naponta egyszer frissülnek). */
  salesFetched: number;
  fetched: string[];
  failed: { sku: string; error: string }[];
  skippedUnknown: string[];
  notDueYet: number;
  notificationsSent: number;
  /** Azonnali üzletek (mannco ↔ backpack.tf): összes és ajánlott; null, ha a mannco nincs beállítva. */
  deals: { total: number; recommended: number } | null;
  /** Hány új vételi lehetőségről ment összefoglaló üzenet. */
  digestOpportunities: number;
}

export type AnalysisResult = ReturnType<ArbitrageService['analyzeItemHistory']>;
export type AnalysisEntry = AnalysisResult | { sku: string; error: string };

export interface AnalysisFile {
  analyzedAt: string;
  keyPriceMetal: number | null;
  results: AnalysisEntry[];
}

const UNKNOWN_SKU_ERROR = 'Ismeretlen SKU: nem szerepel a pricedb.io tárgylistájában.';
/** Az első, hosszabb futás alatt ennyi letöltésenként mentünk részeredményt, hogy a felület hamar mutasson valamit. */
const PROGRESS_EVERY = 25;

/** Csökkenő sorrend a legjobb vételi útvonal óvatos haszna (kulcs) szerint; az elemzés nélküli tárgyak a végére kerülnek. */
export const byProfit = (a: AnalysisEntry, b: AnalysisEntry) => profitOf(b) - profitOf(a);
const profitOf = (r: AnalysisEntry) => ('bestRoute' in r ? r.bestRoute.conservativeProfitKeys : -Infinity);

/** Az elemzés szinkron és tárgyanként több tíz ms; közben visszaadjuk a vezérlést, hogy az API válaszolni tudjon. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Időzített gyűjtés és elemzés a teljes piacon:
 * 1. Előszűrés: a teljes árlistából (egy kérés) kiválasztja a vételre esélyes tárgyakat (lásd MarketScreener).
 * 2. A jelöltek, a külön értesítésre jelölt tárgyak és a legutóbb vételre ajánlottak history-ját letölti a
 *    pricedb.io-ról (futásonként csak az esedékeseket, legfeljebb `maxSkusPerRun` darabot, kérések között
 *    szünettel), és a korábban mentettel összefésülve elmenti.
 * 3. Mindegyiket elemzi, haszon szerint csökkenő sorrendbe rendezi, és az ajánlás változásairól Discord
 *    értesítést küld.
 */
export class CollectorService {
  private running = false;
  private rerunRequested = false;
  private lastRun?: RunSummary;
  private keyPriceCache?: KeyPricePoint[];
  private itemsCache?: PriceDbItem[];

  constructor(
    private client = new PriceDbClient(config.pricedbBaseUrl, config.collector.requestDelayMs),
    private store = new FileStore(config.dataDir),
    private arbitrage = new ArbitrageService(),
    private screener = new MarketScreener(client, store),
  ) {}

  get isRunning() {
    return this.running;
  }

  /**
   * Gyűjtés indítása. Ha már fut egy, `queueIfRunning` esetén a mostani után még egyszer lefut
   * (például ha új tárgyra kértél értesítést), különben kimarad.
   */
  async run(reason: string, queueIfRunning = false): Promise<RunSummary | null> {
    if (this.running) {
      if (queueIfRunning) this.rerunRequested = true;
      console.log(`[collector] Már fut egy gyűjtés, ez ${queueIfRunning ? 'utána lefut' : 'kimarad'} (${reason}).`);
      return null;
    }
    this.running = true;
    const requestsBefore = this.client.requestCount;
    const summary: RunSummary = {
      reason, startedAt: new Date().toISOString(), requests: 0, screen: null, analyzed: 0, salesFetched: 0, fetched: [], failed: [],
      skippedUnknown: [], notDueYet: 0, notificationsSent: 0, deals: null, digestOpportunities: 0,
    };
    this.lastRun = summary;

    try {
      const state = await this.readState();
      const knownSkus = await this.refreshItemsIfStale(state);
      const screen = await this.screenMarket(summary);

      const targets = (await this.targetSkus(screen)).filter((sku) => {
        if (knownSkus && !knownSkus.has(sku)) {
          summary.skippedUnknown.push(sku);
          state.skus[sku] = { ...state.skus[sku], lastError: UNKNOWN_SKU_ERROR };
          return false;
        }
        return true;
      });
      summary.analyzed = targets.length;

      // A kulcsár mindig kell az átváltáshoz, ezért a kvótán felül, elsőként frissül. A többi közül a
      // legrégebben frissített megy előre; a soha le nem töltöttek közül a jobb jelölt.
      const now = Date.now();
      const isDue = (sku: string) =>
        now - (state.skus[sku]?.lastAttemptAt ?? 0) >= config.collector.historyRefreshMinutes * 60_000;
      const dueTargets = targets
        .filter(isDue)
        .sort((a, b) => (state.skus[a]?.lastAttemptAt ?? 0) - (state.skus[b]?.lastAttemptAt ?? 0));
      const batch = [...(isDue(KEY_SKU) ? [KEY_SKU] : []), ...dueTargets.slice(0, config.collector.maxSkusPerRun)];
      summary.notDueYet = targets.length - dueTargets.length;

      console.log(
        `[collector] Indul (${reason}): ${targets.length} tárgy elemzése, ${batch.length} lekérdezés, ` +
        `${summary.notDueYet} még nem esedékes.`,
      );

      // A tényleges (mannco) eladások az eladási idő becsléséhez; tárgyanként naponta egyszer
      // (Kiegészítő adat: a hibája nem állíthatja le a gyűjtést, az elemzés nélküle is lefut.)
      try {
        summary.salesFetched = await manncoService.refreshSales(targets);
      } catch (error) {
        console.warn(`[mannco] Az eladási adatok frissítése sikertelen: ${(error as Error).message}`);
      }
      if (summary.salesFetched > 0) console.log(`[mannco] ${summary.salesFetched} tárgy eladási adatai frissítve.`);

      for (const [i, sku] of batch.entries()) {
        const skuState: SkuState = { ...state.skus[sku], lastAttemptAt: Date.now() };
        try {
          const fresh = await this.client.getItemHistory(sku);
          const merged = await this.mergeHistory(sku, fresh);
          Object.assign(skuState, { lastSuccessAt: Date.now(), lastError: undefined, entries: merged.length });
          summary.fetched.push(sku);
          if (sku === KEY_SKU) this.keyPriceCache = undefined;
        } catch (error) {
          skuState.lastError = (error as Error).message;
          summary.failed.push({ sku, error: skuState.lastError });
          console.warn(`[collector] ${sku} lekérdezése sikertelen: ${skuState.lastError}`);
        }
        state.skus[sku] = skuState;
        // Minden SKU után mentünk, hogy egy megszakadt futás se vesszen el
        await this.store.write('state.json', state);
        if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < batch.length) await this.analyzeAll(state, targets);
      }

      const analysis = await this.analyzeAll(state, targets);
      const names = namesIndex(await this.getItems());
      summary.notificationsSent = await notifyRecommendationChanges(
        analysis.results,
        (sku) => preferencesService.isItemNotified(sku),
        (sku, name) => bptfStatsUrl(sku, names.get(sku) ?? name, names),
      );

      // Azonnali üzletek a két piac között (a buy orderek lekérése percenként korlátozott, ezért ez a végére kerül)
      if (this.screener.context) {
        const deals = await dealsService.run(this.screener.context);
        if (deals) {
          summary.deals = {
            total: deals.deals.length,
            recommended: deals.deals.filter((d) => d.recommendation === 'BUY').length,
          };
          summary.notificationsSent += await dealsService.notify(deals, (sku) => preferencesService.isItemNotified(sku));
        }
      }

      // Összefoglaló az újonnan talált vételi lehetőségekről (egy üzenet a keresés végén)
      summary.digestOpportunities = await sendScanDigest({
        results: analysis.results,
        deals: (await dealsService.get())?.deals ?? [],
        prefs: await preferencesService.get(),
        filter: await filterService.get(),
        bptfUrlFor: (sku, name) => bptfStatsUrl(sku, names.get(sku) ?? name, names),
      });
      if (summary.digestOpportunities > 0) {
        console.log(`[digest] Összefoglaló elküldve: ${summary.digestOpportunities} új vételi lehetőség.`);
      }
    } catch (error) {
      console.error('[collector] A gyűjtés hibával leállt:', error);
      summary.failed.push({ sku: '*', error: (error as Error).message });
    } finally {
      summary.requests = this.client.requestCount - requestsBefore;
      summary.finishedAt = new Date().toISOString();
      this.running = false;
      console.log(
        `[collector] Kész: ${summary.analyzed} elemezve, ${summary.fetched.length} frissítve, ` +
        `${summary.failed.length} hiba, ${summary.requests} kérés, ${summary.notificationsSent} értesítés.`,
      );
    }

    if (this.rerunRequested) {
      this.rerunRequested = false;
      setImmediate(() => void this.run('sorban álló'));
    }
    return summary;
  }

  /** Előszűrés a teljes piacon; ha az árlista nem érhető el, a legutóbbi előszűrés jelöltjeivel megyünk tovább. */
  private async screenMarket(summary: RunSummary): Promise<ScreenResult | null> {
    try {
      const screen = await this.screener.screen();
      summary.screen = { ...screen, candidates: screen.candidates.length };
      console.log(
        `[screener] ${screen.scanned} tárgy átnézve: ${screen.profitableNow} most nyereséges, ` +
        `${screen.persistent} tartósan (${screen.snapshotsUsed} pillanatkép), ${screen.candidates.length} kap teljes elemzést.`,
      );
      return screen;
    } catch (error) {
      console.warn(`[screener] Az előszűrés sikertelen, a legutóbbit használjuk: ${(error as Error).message}`);
      return this.screener.getLastScreen();
    }
  }

  /**
   * Az elemzendő tárgyak: a külön értesítésre jelöltek, a legutóbb vételre ajánlottak (hogy kiderüljön, ha
   * már nem azok) és az előszűrés jelöltjei.
   */
  private async targetSkus(screen: ScreenResult | null): Promise<string[]> {
    const previousBuys = ((await this.getAnalysis())?.results ?? [])
      .filter((r) => 'isWorthBuying' in r && r.isWorthBuying)
      .map((r) => r.sku);
    const candidates = screen?.candidates.map((c) => c.sku) ?? [];
    return [...new Set([...(await preferencesService.notifiedSkus()), ...previousBuys, ...candidates])]
      .filter((sku) => sku !== KEY_SKU);
  }

  /** A pricedb.io tárgylistáját naponta egyszer frissíti; az SKU-k ellenőrzésére és a keresőhöz használjuk. */
  private async refreshItemsIfStale(state: CollectorState): Promise<Set<string> | undefined> {
    let items = await this.getItems();
    const stale = Date.now() - (state.itemsFetchedAt ?? 0) >= config.collector.itemsRefreshHours * 3_600_000;
    if (items.length === 0 || stale) {
      try {
        items = await this.client.getItems();
        await this.store.write('items.json', items);
        this.itemsCache = items;
        state.itemsFetchedAt = Date.now();
        console.log(`[collector] Tárgylista frissítve: ${items.length} tárgy.`);
      } catch (error) {
        console.warn(`[collector] A tárgylista frissítése sikertelen, a korábbit használjuk: ${(error as Error).message}`);
      }
    }
    return items.length > 0 ? new Set(items.map((i) => i.sku)) : undefined;
  }

  async getItems(): Promise<PriceDbItem[]> {
    if (!this.itemsCache?.length) {
      this.itemsCache = await this.store.read<PriceDbItem[]>('items.json', []);
    }
    return this.itemsCache;
  }

  /**
   * Keresés a pricedb.io tárgylistájában: minden szónak szerepelnie kell a névben vagy az SKU-ban.
   * Az SKU-egyezés és a rövidebb (alapabb) nevek kerülnek előre.
   */
  async searchItems(query: string, limit = 20): Promise<PriceDbItem[]> {
    const items = await this.getItems();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    const score = (item: PriceDbItem) => {
      const name = item.name.toLowerCase();
      if (item.sku.toLowerCase() === q) return 0;
      if (name === q) return 1;
      if (name.startsWith(q)) return 2;
      return 3;
    };
    return items
      .filter((item) => {
        const haystack = `${item.name} ${item.sku}`.toLowerCase();
        return words.every((w) => haystack.includes(w));
      })
      .sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** Az új és a korábban mentett bejegyzéseket időbélyeg szerint összefésüli (az újabb letöltés nyer). */
  private async mergeHistory(sku: string, fresh: HistoryEntry[]): Promise<HistoryEntry[]> {
    if (!Array.isArray(fresh)) throw new Error('A pricedb.io nem tömböt adott vissza.');
    const stored = await this.getStoredHistory(sku);
    const byTime = new Map<number, HistoryEntry>();
    for (const entry of [...stored, ...fresh.filter((e) => e?.sku === sku)]) byTime.set(entry.time, entry);
    const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
    await this.store.write(historyFile(sku), merged);
    return merged;
  }

  getStoredHistory(sku: string): Promise<HistoryEntry[]> {
    return this.store.read<HistoryEntry[]>(historyFile(sku), []);
  }

  /** A kulcs eladási ára refined metalban, időben (a tárgyak árának átváltásához). */
  async getKeyPriceHistory(): Promise<KeyPricePoint[]> {
    if (!this.keyPriceCache) {
      const history = await this.getStoredHistory(KEY_SKU);
      this.keyPriceCache = history
        .filter((e) => (e.sell?.metal ?? 0) > 0)
        .map((e) => ({ t: e.time, metal: e.sell.metal! }));
    }
    return this.keyPriceCache;
  }

  /** Egy SKU elemzése a mentett history-ból (a kulcsár-history-val átváltva), a mannco.store ajánlatával és tényleges eladásaival együtt, ha vannak. */
  async analyze(sku: string, overrides = {}) {
    const history = await this.getStoredHistory(sku);
    if (history.length === 0) return null;
    const keyPrices = await this.getKeyPriceHistory();
    const options = { ...envAnalysisOptions(), ...overrides } as Record<string, unknown>;
    // A letöltött kulcsár-history pontosabb, mint a .env-ben megadott fix kulcsár
    if (keyPrices.length > 0 && !('keyPriceMetal' in overrides)) delete options.keyPriceMetal;
    return this.arbitrage.analyzeItemHistory(
      history, options, keyPrices, await manncoService.alternativeFor(sku), await manncoService.salesFor(sku),
    );
  }

  /**
   * Egy tárgy részletes statisztikája a grafikonokhoz: az elemzés az idősorokkal és a visszateszt hozamaival, a
   * mannco napi eladásai (kulcsra is váltva), a legolcsóbb ajánlat és a legmagasabb buy order. Null, ha nincs history.
   */
  async getItemStats(sku: string) {
    const history = await this.getStoredHistory(sku);
    if (history.length === 0) return null;
    const keyPrices = await this.getKeyPriceHistory();
    const options = { ...envAnalysisOptions() } as Record<string, unknown>;
    if (keyPrices.length > 0) delete options.keyPriceMetal;
    const analysis = this.arbitrage.analyzeItemHistory(
      history, options, keyPrices, await manncoService.alternativeFor(sku), await manncoService.salesFor(sku), true,
    );

    const offers = await manncoService.get();
    const keyCents = offers?.keyPriceCents ?? null;
    const toKeys = (cents: number) => (keyCents ? Math.round((cents / keyCents) * 1000) / 1000 : null);
    const offer = offers?.offers[sku];
    const bid = await manncoService.bidFor(sku);
    const days = await manncoService.salesDaysFor(sku);
    const ids = await manncoService.idsFor(sku);
    return {
      sku,
      analysis,
      mannco: ids ? {
        keyPriceUsd: keyCents ? keyCents / 100 : null,
        offer: offer ? { usd: offer.priceCents / 100, keys: toKeys(offer.priceCents), stock: offer.stock } : null,
        bid: bid && bid.bidCents > 0 ? { usd: bid.bidCents / 100, keys: toKeys(bid.bidCents), fetchedAt: bid.fetchedAt } : null,
        // [nap kezdete (ms), darab, darabár (USD), darabár (kulcs, a mostani mannco kulcsárral)]
        sales: (days ?? []).map(([t, count, unitCents]) => [t, count, unitCents / 100, toKeys(unitCents)]),
        salesLoaded: !!days,
      } : null,
    };
  }

  private async analyzeAll(state: CollectorState, skus: string[]): Promise<AnalysisFile> {
    const results: AnalysisEntry[] = [];
    for (const sku of skus) {
      try {
        const result = await this.analyze(sku);
        if (result) results.push(result);
        else results.push({ sku, error: state.skus[sku]?.lastError ?? 'Még nincs letöltött history.' });
      } catch (error) {
        results.push({ sku, error: (error as Error).message });
      }
      await yieldToEventLoop();
    }
    results.sort(byProfit);

    const keyPrices = await this.getKeyPriceHistory();
    const analysis: AnalysisFile = {
      analyzedAt: new Date().toISOString(),
      keyPriceMetal: keyPrices.at(-1)?.metal ?? null,
      results,
    };
    await this.store.write('analysis.json', analysis);
    return analysis;
  }

  getAnalysis() {
    return this.store.read<AnalysisFile | null>('analysis.json', null);
  }

  getLastScreen() {
    return this.screener.getLastScreen();
  }

  private readState() {
    return this.store.read<CollectorState>('state.json', { skus: {} });
  }

  async getSkuStates(): Promise<Record<string, SkuState>> {
    return (await this.readState()).skus;
  }

  async getStatus() {
    const state = await this.readState();
    const toIso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);
    return {
      running: this.running,
      config: { ...config.collector, ...config.market },
      lastRun: this.lastRun ?? null,
      itemsFetchedAt: toIso(state.itemsFetchedAt) ?? null,
      skus: Object.fromEntries(
        Object.entries(state.skus).map(([sku, s]) => [sku, {
          ...s, lastAttemptAt: toIso(s.lastAttemptAt), lastSuccessAt: toIso(s.lastSuccessAt),
        }]),
      ),
    };
  }
}

export const collectorService = new CollectorService();

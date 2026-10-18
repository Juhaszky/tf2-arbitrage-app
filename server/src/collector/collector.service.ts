import { PriceDbClient, PriceDbItem } from '../clients/pricedb.client';
import { KEY_SKU, config, envAnalysisOptions } from '../config';
import { notifyRecommendationChanges } from '../notifications/notifier';
import { ArbitrageService, HistoryEntry, KeyPricePoint } from '../services/arbitrage.service';
import { FileStore, historyFile } from '../storage/file.store';
import { trackingService } from '../tracking/tracking.service';

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
  fetched: string[];
  failed: { sku: string; error: string }[];
  skippedUnknown: string[];
  notDueYet: number;
  notificationsSent: number;
}

export type AnalysisResult = ReturnType<ArbitrageService['analyzeItemHistory']>;
export type AnalysisEntry = AnalysisResult | { sku: string; error: string };

export interface AnalysisFile {
  analyzedAt: string;
  keyPriceMetal: number | null;
  results: AnalysisEntry[];
}

const RECOMMENDATION_ORDER = ['BUY', 'WATCH', 'INSUFFICIENT_DATA', 'AVOID'];
const UNKNOWN_SKU_ERROR = 'Ismeretlen SKU: nem szerepel a pricedb.io tárgylistájában.';

/**
 * Időzítve begyűjti a követett SKU-k history-ját a pricedb.io-ról. Futásonként csak az esedékes
 * (régen frissített) SKU-kat kérdezi le, legfeljebb `maxSkusPerRun` darabot, kérések között szünettel.
 * A history-kat összefésülve fájlba menti, így az adat idővel gyűlik, majd minden SKU-t újraelemez,
 * és az ajánlás változásairól Discord értesítést küld.
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
  ) {}

  get isRunning() {
    return this.running;
  }

  /**
   * Gyűjtés indítása. Ha már fut egy, `queueIfRunning` esetén a mostani után még egyszer lefut
   * (például új tárgy felvételekor), különben kimarad.
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
      reason, startedAt: new Date().toISOString(), requests: 0, fetched: [], failed: [], skippedUnknown: [], notDueYet: 0,
      notificationsSent: 0,
    };
    this.lastRun = summary;

    try {
      const state = await this.readState();
      const knownSkus = await this.refreshItemsIfStale(state);
      await this.fillMissingNames();

      const tracked = (await trackingService.list()).map((i) => i.sku).filter((sku) => {
        if (knownSkus && !knownSkus.has(sku)) {
          summary.skippedUnknown.push(sku);
          state.skus[sku] = { ...state.skus[sku], lastError: UNKNOWN_SKU_ERROR };
          return false;
        }
        return true;
      });

      // A kulcsár mindig kell az átváltáshoz, ezért a kvótán felül, elsőként frissül
      const now = Date.now();
      const isDue = (sku: string) =>
        now - (state.skus[sku]?.lastAttemptAt ?? 0) >= config.collector.historyRefreshMinutes * 60_000;
      const dueTracked = tracked
        .filter(isDue)
        .sort((a, b) => (state.skus[a]?.lastAttemptAt ?? 0) - (state.skus[b]?.lastAttemptAt ?? 0));
      const batch = [...(isDue(KEY_SKU) ? [KEY_SKU] : []), ...dueTracked.slice(0, config.collector.maxSkusPerRun)];
      summary.notDueYet = tracked.length - dueTracked.length;

      console.log(`[collector] Indul (${reason}): ${batch.length} lekérdezés, ${summary.notDueYet} SKU még nem esedékes.`);

      for (const sku of batch) {
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
      }

      await this.store.write('state.json', state);
      const analysis = await this.analyzeAll(state);
      summary.notificationsSent = await notifyRecommendationChanges(analysis.results, await trackingService.list());
    } catch (error) {
      console.error('[collector] A gyűjtés hibával leállt:', error);
      summary.failed.push({ sku: '*', error: (error as Error).message });
    } finally {
      summary.requests = this.client.requestCount - requestsBefore;
      summary.finishedAt = new Date().toISOString();
      this.running = false;
      console.log(
        `[collector] Kész: ${summary.fetched.length} frissítve, ${summary.failed.length} hiba, ` +
        `${summary.requests} kérés, ${summary.notificationsSent} értesítés.`,
      );
    }

    if (this.rerunRequested) {
      this.rerunRequested = false;
      setImmediate(() => void this.run('sorban álló'));
    }
    return summary;
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

  /** A .env-ből átvett tárgyaknak eleinte csak SKU-juk van; a nevet a tárgylistából pótoljuk. */
  private async fillMissingNames() {
    const items = await this.getItems();
    for (const tracked of await trackingService.list()) {
      if (tracked.name !== tracked.sku) continue;
      const name = items.find((i) => i.sku === tracked.sku)?.name;
      if (name) await trackingService.update(tracked.sku, { name });
    }
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

  /** Egy SKU elemzése a mentett history-ból (a kulcsár-history-val átváltva). */
  async analyze(sku: string, overrides = {}) {
    const history = await this.getStoredHistory(sku);
    if (history.length === 0) return null;
    const keyPrices = await this.getKeyPriceHistory();
    const options = { ...envAnalysisOptions(), ...overrides } as Record<string, unknown>;
    // A letöltött kulcsár-history pontosabb, mint a .env-ben megadott fix kulcsár
    if (keyPrices.length > 0 && !('keyPriceMetal' in overrides)) delete options.keyPriceMetal;
    return this.arbitrage.analyzeItemHistory(history, options, keyPrices);
  }

  private async analyzeAll(state: CollectorState): Promise<AnalysisFile> {
    const results: AnalysisEntry[] = [];
    for (const { sku } of await trackingService.list()) {
      try {
        const result = await this.analyze(sku);
        if (result) results.push(result);
        else results.push({ sku, error: state.skus[sku]?.lastError ?? 'Még nincs letöltött history.' });
      } catch (error) {
        results.push({ sku, error: (error as Error).message });
      }
    }

    const rank = (r: AnalysisEntry) =>
      'recommendation' in r ? RECOMMENDATION_ORDER.indexOf(r.recommendation) : RECOMMENDATION_ORDER.length;
    const margin = (r: AnalysisEntry) => ('profit' in r ? r.profit.conservativeMarginPercent : -Infinity);
    results.sort((a, b) => rank(a) - rank(b) || margin(b) - margin(a));

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
      config: { ...config.collector, trackedSkus: (await trackingService.list()).map((i) => i.sku) },
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

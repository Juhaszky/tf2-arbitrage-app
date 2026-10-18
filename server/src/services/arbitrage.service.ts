import { median, quantile, robustSpread, theilSenSlope, wilsonLowerBound } from '../utils/stats';

export interface Price {
  keys: number;
  metal?: number;
}

export interface HistoryEntry {
  name: string;
  sku: string;
  source: string;
  time: number;
  buy: Price;
  sell: Price;
}

export interface AnalysisOptions {
  /** Egy kulcs ára refined metalban – kötelező, ha bármelyik árban van metal. */
  keyPriceMetal?: number;
  /** Az árszint, az ingadozás és a trend ennyi napra visszamenőleg számít. */
  windowDays: number;
  /** A visszateszt ennyi napra visszamenőleg fut. */
  backtestDays: number;
  /** Ennél régebbi legutolsó bejegyzés esetén az elemzés elavult. */
  maxDataAgeHours: number;
  /** Ennyi árbejegyzés kell legalább a visszateszt időszakában (kiugrók nélkül). */
  minPoints: number;
  /** Ennyi napot kell lefednie a history-nak. */
  minHistoryDays: number;
  /** Ennyi idő alatt számolunk azzal, hogy a tárgyat továbbadod. */
  holdingDays: number;
  /** Eladáskor levont díj százalékban (pl. piactér jutalék). */
  sellFeePercent: number;
  /** Az óvatos becslés szerinti minimális haszonkulcs. */
  minMarginPercent: number;
  /** Az óvatos becslés szerinti minimális haszon kulcsban. */
  minProfitKeys: number;
  /** Az eladási ár megengedett robusztus relatív szórása. */
  maxVolatilityPercent: number;
  /** Az eladási ár megengedett legnagyobb heti esése. */
  maxDownTrendPercentPerWeek: number;
  /** A visszatesztben a nyereséges ügyletek minimális aránya. */
  minWinRatePercent: number;
  /** Ennyi egymástól független (nem átfedő) visszatesztelt ügylet kell legalább. */
  minBacktestTrades: number;
  /** Ennyi árváltozás kell naponta (a forgalom közelítése). */
  minUpdatesPerDay: number;
}

export const DEFAULT_OPTIONS: AnalysisOptions = {
  windowDays: 30,
  backtestDays: 90,
  maxDataAgeHours: 72,
  minPoints: 5,
  minHistoryDays: 30,
  holdingDays: 3,
  sellFeePercent: 0,
  minMarginPercent: 10,
  minProfitKeys: 0.05,
  maxVolatilityPercent: 15,
  maxDownTrendPercentPerWeek: 5,
  minWinRatePercent: 90,
  minBacktestTrades: 15,
  minUpdatesPerDay: 0.1,
};

export type Recommendation = 'BUY' | 'WATCH' | 'AVOID' | 'INSUFFICIENT_DATA';
type CheckCategory = 'data' | 'profit' | 'risk';

export interface Check {
  id: string;
  category: CheckCategory;
  passed: boolean;
  value: number;
  threshold: number;
  message: string;
}

/** Hibás bemenet – a controller 400-as válaszként adja vissza. */
export class AnalysisInputError extends Error {}

/** A kulcs ára refined metalban egy adott időponttól (lépcsős idősor). */
export interface KeyPricePoint {
  t: number; // másodperc
  metal: number;
}

interface Point {
  t: number; // másodperc
  buy: number; // kulcs
  sell: number; // kulcs
}

const DAY = 86400;
const SAMPLE_STEP = 3600; // óránkénti mintavétel
const RECENT_POINTS = 3;
const OUTLIER_Z = 3.5;
const OUTLIER_NEIGHBOURS = 3;
const OUTLIER_MIN_SPREAD = 0.02; // a medián 2%-a
const EXIT_QUANTILE = 0.25; // a visszatesztben a tartási idő alatti eladási árak alsó negyede

const round = (v: number, digits = 2) => (Number.isFinite(v) ? parseFloat(v.toFixed(digits)) : 0);

export class ArbitrageService {
  public analyzeItemHistory(
    entries: HistoryEntry[],
    overrides: Partial<AnalysisOptions> = {},
    keyPriceHistory?: KeyPricePoint[],
  ) {
    const opts: AnalysisOptions = { ...DEFAULT_OPTIONS, ...overrides };
    const fee = opts.sellFeePercent / 100;
    const holding = opts.holdingDays * DAY;

    // Kulcsár: a fix érték elsőbbséget élvez, különben a kulcsár-history-ból a bejegyzés idején érvényes ár
    const keyHistory = opts.keyPriceMetal === undefined && keyPriceHistory?.length
      ? [...keyPriceHistory].sort((a, b) => a.t - b.t)
      : undefined;
    const keyPriceAt = keyHistory
      ? (t: number) => stepValueAt(keyHistory, t)
      : opts.keyPriceMetal ? () => opts.keyPriceMetal! : undefined;
    const currentKeyPrice = keyPriceAt?.(Date.now() / 1000);

    const { sku, itemName, points } = this.normalize(entries, keyPriceAt, !keyHistory);

    // A history árváltozások sorozata: minden ár a következő bejegyzésig érvényes (lépcsős idősor),
    // az utolsó ár pedig egészen mostanáig.
    const latestT = points[points.length - 1].t;
    const end = Math.max(latestT, Date.now() / 1000);
    const backtestStart = Math.max(points[0].t, end - opts.backtestDays * DAY);
    const windowStart = Math.max(points[0].t, end - opts.windowDays * DAY);

    // 1. A visszateszt időszakának bejegyzései + az előtte utolsó (az időszak elején az az érvényes ár)
    const firstInRange = points.findIndex((p) => p.t >= backtestStart);
    const events = points.slice(Math.max(0, firstInRange - 1));

    // 2. Kiugró értékek kiszűrése a szomszédos bejegyzésekhez mérve (Hampel-szűrő), így egy tartós
    //    árváltozás nem számít kiugrónak, csak a rövid tüske. A legfrissebb bejegyzések maradnak,
    //    mert egy friss áresés nem zaj, hanem kockázat.
    const clean = events.filter((_, i) => i >= events.length - RECENT_POINTS || !isLocalOutlier(events, i));
    const outliersRemoved = events.length - clean.length;

    // 3. Óránkénti minták a lépcsős idősorból – így minden ár annyi ideig számít, ameddig érvényes volt
    const samples = sampleSteps(clean, backtestStart, end, SAMPLE_STEP);
    const windowSamples = samples.filter((s) => s.t >= windowStart);
    const buys = windowSamples.map((s) => s.buy);
    const sells = windowSamples.map((s) => s.sell);

    // 4. Jelenlegi ár: a legutolsó érvényes ár
    const currentBuy = clean[clean.length - 1].buy;
    const currentSell = clean[clean.length - 1].sell;

    // 5. Trend és ingadozás az ablakban
    const sellSlopePerDay = theilSenSlope(windowSamples.map((s) => s.t / DAY), sells);
    const medianSell = median(sells);
    const sellTrendPercentPerWeek = medianSell > 0 ? ((sellSlopePerDay * 7) / medianSell) * 100 : 0;
    const volatilityPercent = medianSell > 0 ? (robustSpread(sells) / medianSell) * 100 : 0;

    // 6. Várható (tipikus) és óvatos (pesszimista) becslés
    const medianBuy = median(buys);
    const expectedProfit = medianSell * (1 - fee) - medianBuy;

    // Óvatos vétel: drágább vételi ár; óvatos eladás: olcsóbb eladási ár, és a csökkenő trend is levonásra kerül
    const conservativeBuy = Math.max(quantile(buys, 0.75), currentBuy);
    const projectedSell = currentSell + Math.min(sellSlopePerDay, 0) * opts.holdingDays;
    const conservativeSellNet = Math.min(quantile(sells, 0.25), projectedSell) * (1 - fee);
    const conservativeProfit = conservativeSellNet - conservativeBuy;
    const conservativeMargin = conservativeBuy > 0 ? (conservativeProfit / conservativeBuy) * 100 : 0;

    // 7. Visszateszt: ha a múltban bármikor megvetted volna, a tartási időn belüli
    //    legrosszabb eladási áron is nyereséges lett volna?
    const backtest = this.backtest(samples, holding, fee);

    // 8. Adatminőség és forgalom (az árváltozások gyakorisága)
    const historyDays = (end - points[0].t) / DAY;
    const backtestPeriodDays = (end - backtestStart) / DAY;
    const changesInPeriod = clean.filter((p) => p.t >= backtestStart).length;
    const updatesPerDay = backtestPeriodDays > 0 ? changesInPeriod / backtestPeriodDays : 0;
    const estimatedSaleSpeed =
      updatesPerDay >= 1 ? 'FAST' : updatesPerDay >= opts.minUpdatesPerDay ? 'NORMAL' : 'SLOW';
    const dataAgeHours = Math.max(0, (Date.now() / 1000 - latestT) / 3600);

    // 9. Ellenőrzések
    const checks: Check[] = [
      check('DATA_POINTS', 'data', changesInPeriod >= opts.minPoints, changesInPeriod, opts.minPoints,
        `Az utolsó ${round(backtestPeriodDays, 0)} napban ${changesInPeriod} árbejegyzés van, legalább ${opts.minPoints} kell.`),
      check('HISTORY_SPAN', 'data', historyDays >= opts.minHistoryDays, historyDays, opts.minHistoryDays,
        `A history ${round(historyDays, 1)} napot fed le, legalább ${opts.minHistoryDays} kell.`),
      check('FRESHNESS', 'data', dataAgeHours <= opts.maxDataAgeHours, dataAgeHours, opts.maxDataAgeHours,
        `A legutolsó bejegyzés ${round(dataAgeHours, 1)} órás, legfeljebb ${opts.maxDataAgeHours} órás lehet.`),
      check('BACKTEST_SAMPLE', 'data', backtest.independentTrades >= opts.minBacktestTrades, backtest.independentTrades, opts.minBacktestTrades,
        `Független visszatesztelt ügyletek: ${backtest.independentTrades}, legalább ${opts.minBacktestTrades} kell.`),
      check('CONSERVATIVE_MARGIN', 'profit', conservativeMargin >= opts.minMarginPercent, conservativeMargin, opts.minMarginPercent,
        `Óvatos haszonkulcs: ${round(conservativeMargin, 1)}%, legalább ${opts.minMarginPercent}% kell.`),
      check('CONSERVATIVE_PROFIT', 'profit', conservativeProfit >= opts.minProfitKeys, conservativeProfit, opts.minProfitKeys,
        `Óvatos haszon: ${round(conservativeProfit, 3)} kulcs, legalább ${opts.minProfitKeys} kell.`),
      check('WIN_RATE', 'risk', backtest.winRatePercent >= opts.minWinRatePercent, backtest.winRatePercent, opts.minWinRatePercent,
        `A visszatesztben az időszak ${round(backtest.winRatePercent, 1)}%-ában lett volna nyereséges a vétel, legalább ${opts.minWinRatePercent}% kell.`),
      // Csak akkor bukik el, ha a nyerési arány jónak látszik, de nem elég meggyőzően a küszöb fölött
      check('WIN_RATE_CONFIDENCE', 'risk',
        backtest.winRatePercent < opts.minWinRatePercent || backtest.winRateLowerBoundPercent >= opts.minWinRatePercent,
        backtest.winRateLowerBoundPercent, opts.minWinRatePercent,
        `A ${round(backtest.winRatePercent, 1)}%-os nyerési arány nem elég meggyőző: ${backtest.independentTrades} független ügyletből ` +
        `90%-os biztonsággal csak ${round(backtest.winRateLowerBoundPercent, 1)}% igazolható, ${opts.minWinRatePercent}% kell.`),
      check('VOLATILITY', 'risk', volatilityPercent <= opts.maxVolatilityPercent, volatilityPercent, opts.maxVolatilityPercent,
        `Az eladási ár ingadozása ${round(volatilityPercent, 1)}%, legfeljebb ${opts.maxVolatilityPercent}% lehet.`),
      check('TREND', 'risk', sellTrendPercentPerWeek >= -opts.maxDownTrendPercentPerWeek, sellTrendPercentPerWeek, -opts.maxDownTrendPercentPerWeek,
        `Az eladási ár heti változása ${round(sellTrendPercentPerWeek, 1)}%, legfeljebb ${opts.maxDownTrendPercentPerWeek}%-os esés megengedett.`),
      check('LIQUIDITY', 'risk', updatesPerDay >= opts.minUpdatesPerDay, updatesPerDay, opts.minUpdatesPerDay,
        `Napi ${round(updatesPerDay)} árváltozás, legalább ${opts.minUpdatesPerDay} kell.`),
    ];

    const failed = checks.filter((c) => !c.passed);
    const failedIn = (cat: CheckCategory) => failed.some((c) => c.category === cat);
    const backtestReliable = backtest.independentTrades >= opts.minBacktestTrades;

    let recommendation: Recommendation;
    if (!(expectedProfit > 0) || !(conservativeProfit > 0) || (backtestReliable && backtest.winRatePercent < 50)) {
      recommendation = 'AVOID';
    } else if (failedIn('data')) {
      recommendation = 'INSUFFICIENT_DATA';
    } else if (failed.length === 0) {
      recommendation = 'BUY';
    } else {
      recommendation = 'WATCH';
    }

    const riskLevel =
      recommendation === 'BUY' ? 'LOW'
      : recommendation === 'WATCH' && !failedIn('risk') ? 'MEDIUM'
      : 'HIGH';

    // Ajánlott legmagasabb vételi ár, amely mellett a küszöbök még teljesülnek
    const maxBuyPrice = Math.max(0, Math.min(
      conservativeSellNet / (1 + opts.minMarginPercent / 100),
      conservativeSellNet - opts.minProfitKeys,
    ));
    const targetSell = Math.min(currentSell, medianSell);

    return {
      sku,
      itemName,
      recommendation,
      isWorthBuying: recommendation === 'BUY',
      riskLevel,
      summary: summarize(recommendation, failed),
      prices: {
        currentBuyKeys: round(currentBuy, 3),
        currentSellKeys: round(currentSell, 3),
        medianBuyKeys: round(medianBuy, 3),
        medianSellKeys: round(medianSell, 3),
        conservativeBuyKeys: round(conservativeBuy, 3),
        conservativeSellNetKeys: round(conservativeSellNet, 3),
        maxBuyPriceKeys: round(maxBuyPrice, 3),
        maxBuyPrice: toKeysMetal(maxBuyPrice, currentKeyPrice, 'down'),
        targetSellKeys: round(targetSell, 3),
        targetSell: toKeysMetal(targetSell, currentKeyPrice, 'nearest'),
      },
      profit: {
        expectedProfitKeys: round(expectedProfit, 3),
        expectedMarginPercent: round(medianBuy > 0 ? (expectedProfit / medianBuy) * 100 : 0, 1),
        conservativeProfitKeys: round(conservativeProfit, 3),
        conservativeMarginPercent: round(conservativeMargin, 1),
      },
      risk: {
        volatilityPercent: round(volatilityPercent, 1),
        sellTrendPercentPerWeek: round(sellTrendPercentPerWeek, 1),
        backtestIndependentTrades: backtest.independentTrades,
        backtestWinRatePercent: round(backtest.winRatePercent, 1),
        backtestWinRateLowerBoundPercent: round(backtest.winRateLowerBoundPercent, 1),
        backtestWorstReturnPercent: round(backtest.worstReturnPercent, 1),
      },
      data: {
        pointsReceived: entries.length,
        historyDays: round(historyDays, 1),
        backtestPeriodDays: round(backtestPeriodDays, 1),
        changesInPeriod,
        outliersRemoved,
        dataAgeHours: round(dataAgeHours, 1),
        updatesPerDay: round(updatesPerDay),
        estimatedSaleSpeed,
      },
      checks: checks.map((c) => ({ ...c, value: round(c.value, 3) })),
      keyPrice: {
        currentMetal: currentKeyPrice ?? null,
        source: keyHistory ? 'history' : opts.keyPriceMetal ? 'fixed' : 'none',
      },
      settings: opts,
    };
  }

  private normalize(entries: HistoryEntry[], keyPriceAt: ((t: number) => number) | undefined, fixedKeyPrice: boolean) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new AnalysisInputError('A bemeneti adat üres vagy nem tömb!');
    }

    const sku = entries[0]?.sku;
    const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const isPrice = (p: Price | undefined) => !!p && isNum(p.keys) && (p.metal === undefined || isNum(p.metal));
    const usesMetal = entries.some((e) => (e?.buy?.metal ?? 0) > 0 || (e?.sell?.metal ?? 0) > 0);

    if (usesMetal && !keyPriceAt) {
      throw new AnalysisInputError(
        'Az árakban metal is szerepel, ezért meg kell adni a kulcs árát (options.keyPriceMetal vagy KEY_PRICE_METAL), ' +
        'vagy meg kell várni, hogy a gyűjtő letöltse a kulcsár history-ját.',
      );
    }

    // Egy árban a metal rész mindig kevesebb egy kulcsnál – ha nem, a megadott fix kulcsár elavult, és az átváltás hibás lenne
    const maxMetal = Math.max(0, ...entries.flatMap((e) => [e?.buy?.metal ?? 0, e?.sell?.metal ?? 0]));
    const fixed = fixedKeyPrice && keyPriceAt ? keyPriceAt(0) : 0;
    if (fixed && maxMetal >= fixed) {
      throw new AnalysisInputError(
        `A megadott kulcsár (${fixed} ref) túl alacsony: az árakban ${maxMetal} ref metal is szerepel, ` +
        'ezért a kulcs legalább ennyit ér. Frissítsd a KEY_PRICE_METAL értékét (vagy az options.keyPriceMetal-t).',
      );
    }

    const points: Point[] = entries.map((e, i) => {
      if (!e || !isNum(e.time) || !isPrice(e.buy) || !isPrice(e.sell)) {
        throw new AnalysisInputError(`Hibás bejegyzés a(z) ${i}. helyen: time, buy.keys és sell.keys kötelező, nemnegatív szám.`);
      }
      if (e.sku !== sku) {
        throw new AnalysisInputError(`Egy kérésben csak egy tárgy lehet (a(z) ${i}. bejegyzés SKU-ja eltér: ${e.sku}).`);
      }
      // Ezredmásodperces időbélyeg esetén átváltjuk másodpercre
      const t = e.time > 1e12 ? e.time / 1000 : e.time;
      // A kulcsár-history és a tárgy ára nem pontosan ugyanakkor frissül; mivel a metal rész mindig
      // kevesebb egy kulcsnál, a kulcsárat legalább a metal rész + 1 scrap értékre emeljük.
      const toKeys = (p: Price) => {
        const metal = p.metal ?? 0;
        return metal > 0 && keyPriceAt ? p.keys + metal / Math.max(keyPriceAt(t), metal + 1 / 9) : p.keys;
      };
      return { t, buy: toKeys(e.buy), sell: toKeys(e.sell) };
    });

    points.sort((a, b) => a.t - b.t);
    return { sku, itemName: entries[0].name, points };
  }

  /**
   * Minden órai mintára: ha akkor veszel, és a tartási idő alatti eladási árak alsó negyedén (P25)
   * adod el, nyersz-e? A P25 pesszimista, de egy-egy rövid, pár órás árhiba nem dönti el egyedül.
   * Az egymást átfedő ügyletek nem függetlenek, ezért a konfidenciahatárhoz csak annyi ügyletet
   * számolunk, ahány nem átfedő tartási idő belefér az időszakba.
   */
  private backtest(samples: Point[], holding: number, fee: number) {
    const lastT = samples.length > 0 ? samples[samples.length - 1].t : 0;
    const returns: number[] = [];
    for (let i = 0; i < samples.length && samples[i].t + holding <= lastT; i++) {
      const buy = samples[i].buy;
      if (buy <= 0) continue;
      const horizonSells: number[] = [];
      for (let j = i; j < samples.length && samples[j].t <= samples[i].t + holding; j++) {
        horizonSells.push(samples[j].sell);
      }
      const exitSell = quantile(horizonSells, EXIT_QUANTILE);
      returns.push(((exitSell * (1 - fee) - buy) / buy) * 100);
    }

    const coveredSeconds = returns.length > 0 ? (returns.length - 1) * SAMPLE_STEP : 0;
    const independentTrades = returns.length > 0 ? Math.floor(coveredSeconds / holding) + 1 : 0;
    const winShare = returns.length > 0 ? returns.filter((r) => r > 0).length / returns.length : 0;

    return {
      independentTrades,
      winRatePercent: winShare * 100,
      winRateLowerBoundPercent: wilsonLowerBound(winShare * independentTrades, independentTrades) * 100,
      worstReturnPercent: returns.length > 0 ? Math.min(...returns) : 0,
    };
  }
}

/**
 * Gyanúsan kedvező-e a bejegyzés a környező bejegyzésekhez képest: kiugróan olcsó vétel vagy kiugróan
 * drága eladás? Csak ezeket szűrjük, mert hamis reményt adnának; a kedvezőtlen kiugrók kockázatként
 * bent maradnak. A szórásnak alsó korlátja van, hogy szinte azonos árak mellett egy pár százalékos
 * mozgás ne számítson kiugrónak.
 */
function isLocalOutlier(points: Point[], i: number): boolean {
  const from = Math.max(0, i - OUTLIER_NEIGHBOURS);
  const neighbourhood = points.slice(from, i + OUTLIER_NEIGHBOURS + 1);
  if (neighbourhood.length < 3) return false;
  const z = (side: 'buy' | 'sell') => {
    const values = neighbourhood.map((p) => p[side]);
    const med = median(values);
    const spread = Math.max(robustSpread(values), OUTLIER_MIN_SPREAD * med);
    return spread > 0 ? (points[i][side] - med) / spread : 0;
  };
  return z('buy') < -OUTLIER_Z || z('sell') > OUTLIER_Z;
}

/** Lépcsős idősor mintavételezése: minden időpontban a legutóbbi bejegyzés ára érvényes. */
function sampleSteps(points: Point[], from: number, to: number, step: number): Point[] {
  const samples: Point[] = [];
  let k = 0;
  for (let t = from; t <= to; t += step) {
    while (k + 1 < points.length && points[k + 1].t <= t) k++;
    if (points[k].t <= t) samples.push({ t, buy: points[k].buy, sell: points[k].sell });
  }
  return samples;
}

/** A rendezett lépcsős idősor t időpontban érvényes értéke (bináris kereséssel; t előtt az első érték). */
function stepValueAt(points: KeyPricePoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo].metal;
}

function check(id: string, category: CheckCategory, passed: boolean, value: number, threshold: number, message: string): Check {
  return { id, category, passed, value, threshold, message };
}

function summarize(recommendation: Recommendation, failed: Check[]): string {
  const reasons = failed.map((c) => c.message).join(' ');
  switch (recommendation) {
    case 'BUY':
      return 'Minden ellenőrzés teljesült: óvatos becsléssel is nyereséges, stabil és a múltban megbízhatóan működött.';
    case 'WATCH':
      return `Átlagosan nyereséges, de nem elég biztonságos. ${reasons}`;
    case 'INSUFFICIENT_DATA':
      return `Nincs elég megbízható adat a döntéshez. ${reasons}`;
    case 'AVOID':
      return `Ne vedd meg: veszteséges vagy túl kockázatos. ${reasons}`;
  }
}

/** Kulcs + metal alakra bontás, a metal scrapre (1/9 ref) kerekítve. */
function toKeysMetal(totalKeys: number, keyPriceMetal: number | undefined, mode: 'down' | 'nearest') {
  if (!keyPriceMetal || !Number.isFinite(totalKeys) || totalKeys <= 0) return null;
  const keys = Math.floor(totalKeys);
  const scrap = (totalKeys - keys) * keyPriceMetal * 9;
  const metal = (mode === 'down' ? Math.floor(scrap) : Math.round(scrap)) / 9;
  return { keys, metal: parseFloat(metal.toFixed(2)) };
}

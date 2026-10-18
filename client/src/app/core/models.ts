export type Recommendation = 'BUY' | 'WATCH' | 'INSUFFICIENT_DATA' | 'AVOID';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Money {
  keys: number;
  metal: number;
}

export interface Check {
  id: string;
  category: 'data' | 'profit' | 'risk';
  passed: boolean;
  value: number;
  threshold: number;
  message: string;
}

/** Vétel egy másik piacon (mannco.store) a legolcsóbb ajánlatból, eladás backpack.tf-en. */
export interface AlternativeRoute {
  source: 'mannco';
  label: string;
  url: string | null;
  price: number;
  currency: string;
  stock: number;
  buyKeys: number;
  recommendation: Recommendation;
  isWorthBuying: boolean;
  riskLevel: RiskLevel;
  summary: string;
  profit: {
    expectedProfitKeys: number;
    expectedMarginPercent: number;
    conservativeProfitKeys: number;
    conservativeMarginPercent: number;
  };
  risk: {
    backtestIndependentTrades: number;
    backtestWinRatePercent: number;
    backtestWinRateLowerBoundPercent: number;
  };
  checks: Check[];
}

export interface BestRoute {
  source: 'bptf' | 'mannco';
  recommendation: Recommendation;
  conservativeProfitKeys: number;
}

/** A szerver elemzésének az a része, amelyet a felület használ. */
export interface Analysis {
  sku: string;
  itemName: string;
  /** A backpack.tf-en vett és ott eladott útvonal ajánlása. */
  recommendation: Recommendation;
  /** Megvehető-e bármelyik útvonalon. */
  isWorthBuying: boolean;
  /** A legjobb vételi útvonal (a korábbi elemzésekben még hiányozhat). */
  bestRoute?: BestRoute;
  alternative?: AlternativeRoute | null;
  riskLevel: RiskLevel;
  summary: string;
  prices: {
    currentBuyKeys: number;
    currentSellKeys: number;
    medianBuyKeys: number;
    medianSellKeys: number;
    maxBuyPriceKeys: number;
    maxBuyPrice: Money | null;
    targetSellKeys: number;
    targetSell: Money | null;
  };
  profit: {
    expectedProfitKeys: number;
    expectedMarginPercent: number;
    conservativeProfitKeys: number;
    conservativeMarginPercent: number;
  };
  risk: {
    volatilityPercent: number;
    sellTrendPercentPerWeek: number;
    backtestIndependentTrades: number;
    backtestWinRatePercent: number;
    backtestWinRateLowerBoundPercent: number;
  };
  /** A tényleges (mannco.store) eladások; null, ha nincs párosított mannco tárgy. */
  sales?: {
    sales30: number;
    sales90: number;
    sales365: number;
    expectedDaysToSell: number | null;
  } | null;
  checks: Check[];
}

/** Az előszűrés szerinti jelenlegi árak (kulcsban, a díj levonása után). */
export interface ScreenQuote {
  route: 'bptf' | 'mannco';
  buyKeys: number;
  sellKeys: number;
  profitKeys: number;
  marginPercent: number;
}

export interface MarketItem {
  sku: string;
  name: string;
  /** A tárgy típusai az SKU alapján (pl. Strange Unusual esetén mindkettő). */
  qualities: string[];
  /** A tárgy backpack.tf statisztika-oldala. */
  bptfUrl: string;
  /** Kapsz-e Discord értesítést, amikor vételre vált (vagy már nem ajánlott). */
  notify: boolean;
  analysis: Analysis | null;
  error: string | null;
  lastFetchedAt: string | null;
  /** Null, ha a tárgy nem az előszűrésből, hanem a saját értesítési kérésed miatt van a listán. */
  screen: ScreenQuote | null;
}

export interface ScreenSummary {
  screenedAt: string;
  scanned: number;
  profitableNow: number;
  persistent: number;
  candidates: number;
}

/** Vételi ár (kulcs) és típus szerinti szűrő; a null határ és az üres típuslista nem szűr. */
export interface MarketFilter {
  minKeys: number | null;
  maxKeys: number | null;
  qualities: string[];
}

export interface QualityOption {
  id: string;
  label: string;
}

export interface MarketResponse {
  items: MarketItem[];
  analyzedAt: string | null;
  keyPriceMetal: number | null;
  screen: ScreenSummary | null;
  mannco: { configured: boolean; matched: number | null; profitableNow: number | null; keyPriceUsd: number | null };
  filter: MarketFilter;
  /** Ennyi elemzett tárgyat rejt el a szűrő (pl. korábbi ajánlatok más ártartományból). */
  hiddenByFilter: number;
  /** A szűrő változott, de az új előszűrés még nem készült el. */
  filterPending: boolean;
  qualities: QualityOption[];
  collector: { running: boolean };
  discord: { configured: boolean };
  notifications: { notifyAllBuys: boolean };
}

export interface ItemSearchResult {
  name: string;
  sku: string;
}

export type Market = 'bptf' | 'mannco';

/** Hol veszed → hol adod el. */
export type RouteKey = 'bptf>bptf' | 'mannco>bptf' | 'bptf>mannco';

export type DealType = 'MANNCO_TO_BPTF' | 'MANNCO_ORDER_TO_BPTF' | 'BPTF_TO_MANNCO_ORDER';

export interface DealLeg {
  market: Market;
  action: string;
  keys: number;
  usd: number | null;
}

/** Azonnali (tartás nélküli) üzlet a backpack.tf és a mannco.store között. */
export interface Deal {
  id: string;
  type: DealType;
  sku: string;
  name: string;
  buy: DealLeg;
  sell: DealLeg;
  profitKeys: number;
  marginPercent: number;
  worstProfitKeys: number;
  recommendation: 'BUY' | 'WATCH';
  checks: Check[];
  stock: number | null;
  estimatedFillDays: number | null;
  manncoUrl: string | null;
  bptfUrl: string;
  /** Saját buy ordernél: a javasolt ár alapja (a mostani legmagasabb buy order és a tényleges eladások). */
  order: {
    topBidUsd: number;
    priceUsd: number;
    soldAtOrBelow: number | null;
    windowDays: number | null;
    fromSales: boolean;
  } | null;
  bptfPriceAgeHours: number;
  manncoDataAgeMinutes: number;
  notify: boolean;
}

export interface DealsResponse {
  configured: boolean;
  generatedAt: string | null;
  keyPriceUsd: number | null;
  coverage: { matched: number; bidsFresh: number } | null;
  labels: Record<DealType, string>;
  deals: Deal[];
}

/** Egy kereskedési lépés a felületen: melyik piacon, hogyan és mennyiért. */
export interface TradeStep {
  market: Market;
  how: string;
  price: string;
  /** A tárgy oldala ezen a piacon. */
  url: string | null;
}

/** A felületen megjelenített terv: hol veszed (hol olcsó) és hol adod el. */
export interface TradePlan {
  route: RouteKey;
  buy: TradeStep;
  sell: TradeStep;
  /** Amennyit a vételért fizetsz, kulcsban (rendezéshez). */
  buyKeys: number;
  profitKeys: number;
  marginPercent: number;
  recommendation: Recommendation;
  /** Ez a legjobb útvonal a tárgyra. */
  best: boolean;
}

/** Egy tárgy részletes statisztikája a grafikonokhoz (`GET /api/items/:sku/stats`). */
export interface ItemStats {
  sku: string;
  analysis: Analysis & {
    prices: Analysis['prices'] & { conservativeBuyKeys: number; conservativeSellNetKeys: number };
    data: { changesInPeriod: number; outliersRemoved: number; historyDays: number; backtestPeriodDays: number; holdingDays?: number };
    series: {
      /** [idő (mp), vétel (kulcs), eladás (kulcs), kiugróként kiszűrve] */
      points: [number, number, number, boolean][];
      windowStart: number;
      backtestStart: number;
      holdingDays: number;
      backtestReturns: number[];
      alternativeReturns: number[] | null;
    };
  };
  mannco: {
    keyPriceUsd: number | null;
    offer: { usd: number; keys: number | null; stock: number } | null;
    bid: { usd: number; keys: number | null; fetchedAt: string } | null;
    /** [nap kezdete (ms), darab, darabár (USD), darabár (kulcs)] */
    sales: [number, number, number, number | null][];
    salesLoaded: boolean;
  } | null;
}

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

/** A szerver elemzésének az a része, amelyet a felület használ. */
export interface Analysis {
  sku: string;
  itemName: string;
  recommendation: Recommendation;
  isWorthBuying: boolean;
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
  checks: Check[];
}

export interface TrackedItem {
  sku: string;
  name: string;
  notify: boolean;
  addedAt: string;
  analysis: Analysis | null;
  error: string | null;
  lastFetchedAt: string | null;
}

export interface TrackedResponse {
  items: TrackedItem[];
  analyzedAt: string | null;
  keyPriceMetal: number | null;
  collector: { running: boolean };
  discord: { configured: boolean };
}

export interface ItemSearchResult {
  name: string;
  sku: string;
}

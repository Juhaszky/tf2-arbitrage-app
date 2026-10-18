import { formatKeys, formatMoney, formatUsd } from './format';
import { Deal, DealLeg, MarketItem, Market, RouteKey, TradePlan } from './models';

export const MARKET_LABELS: Record<Market, string> = {
  bptf: 'backpack.tf',
  mannco: 'mannco.store',
};

export const ROUTE_LABELS: Record<RouteKey, string> = {
  'bptf>bptf': 'backpack.tf → backpack.tf',
  'mannco>bptf': 'mannco.store → backpack.tf',
  'bptf>mannco': 'backpack.tf → mannco.store',
};

export const routeOf = (buy: Market, sell: Market) => `${buy}>${sell}` as RouteKey;

/**
 * A tárgy kereskedési tervei az elemzésből: backpack.tf vétel (buy orderrel) és eladás (hirdetéssel), illetve ha
 * van mannco ajánlat, vétel a mannco legolcsóbb ajánlatából és eladás backpack.tf-en. A legjobb útvonal kerül előre.
 */
export function analysisPlans(item: MarketItem): TradePlan[] {
  const a = item.analysis;
  if (!a) return [];
  const bestSource = a.bestRoute?.source ?? 'bptf';
  const sell = {
    market: 'bptf' as const,
    how: 'Hirdetéssel',
    price: formatMoney(a.prices.targetSell, a.prices.targetSellKeys),
    url: item.bptfUrl,
  };

  const plans: TradePlan[] = [{
    route: 'bptf>bptf',
    buy: {
      market: 'bptf',
      how: 'Buy orderrel, legfeljebb',
      price: formatMoney(a.prices.maxBuyPrice, a.prices.maxBuyPriceKeys),
      url: item.bptfUrl,
    },
    sell,
    buyKeys: a.prices.maxBuyPriceKeys,
    profitKeys: a.profit.conservativeProfitKeys,
    marginPercent: a.profit.conservativeMarginPercent,
    recommendation: a.recommendation,
    best: bestSource === 'bptf',
  }];

  const m = a.alternative;
  if (m) {
    plans.push({
      route: 'mannco>bptf',
      buy: {
        market: 'mannco',
        how: `Legolcsóbb ajánlat (${m.stock} db)`,
        price: `${formatUsd(m.price)} ≈ ${formatKeys(m.buyKeys)}`,
        url: m.url,
      },
      sell,
      buyKeys: m.buyKeys,
      profitKeys: m.profit.conservativeProfitKeys,
      marginPercent: m.profit.conservativeMarginPercent,
      recommendation: m.recommendation,
      best: bestSource === 'mannco',
    });
  }
  return plans.sort((x, y) => Number(y.best) - Number(x.best));
}

/** Az elemzett tárgy legjobb útvonala (szűréshez). */
export const bestRouteOf = (item: MarketItem): RouteKey | null => analysisPlans(item)[0]?.route ?? null;

const legPrice = (leg: DealLeg) => (leg.usd !== null ? `${formatUsd(leg.usd)} ≈ ${formatKeys(leg.keys)}` : formatKeys(leg.keys));

/** Az azonnali üzlet terve. */
export function dealPlan(deal: Deal): TradePlan {
  const urlOf = (market: Market) => (market === 'bptf' ? deal.bptfUrl : deal.manncoUrl);
  return {
    route: routeOf(deal.buy.market, deal.sell.market),
    buy: { market: deal.buy.market, how: deal.buy.action, price: legPrice(deal.buy), url: urlOf(deal.buy.market) },
    sell: { market: deal.sell.market, how: deal.sell.action, price: legPrice(deal.sell), url: urlOf(deal.sell.market) },
    buyKeys: deal.buy.keys,
    profitKeys: deal.profitKeys,
    marginPercent: deal.marginPercent,
    recommendation: deal.recommendation,
    best: true,
  };
}

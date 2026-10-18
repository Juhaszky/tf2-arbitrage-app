import type { AnalysisEntry, AnalysisResult } from '../collector/collector.service';
import { config } from '../config';
import type { Deal } from '../market/deals.service';
import { MarketFilter, matchesFilter, qualitiesOf } from '../market/filter.service';
import { FileStore } from '../storage/file.store';
import { COLORS, discordService } from './discord.service';
import type { NotificationPreferences } from './preferences.service';

const FILE = 'scan-digest.json';
/** Egy összefoglalóban legfeljebb ennyi tétel szerepel részletesen. */
const MAX_LINES = 10;
/** A Discord embed leírásának felső határa (4096) alatt maradunk. */
const MAX_DESCRIPTION = 3900;

/** Mely lehetőségekről szóltunk már (ami eltűnik, majd újra megjelenik, arról újra szólunk). */
interface DigestState {
  sentAt: string;
  buys: string[];
  deals: string[];
}

interface Opportunity {
  kind: 'analysis' | 'deal';
  key: string;
  name: string;
  buy: string;
  sell: string;
  profitKeys: number;
  marginPercent: number;
  note?: string;
  /** Unusual: a pricedb ára becsült érték. */
  unusual: boolean;
  links: string;
}

const store = new FileStore(config.dataDir);

const keys = (v: number) => `${v.toLocaleString('hu-HU', { maximumFractionDigits: 2 })} kulcs`;
const usd = (v: number) => `${v.toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const pct = (v: number) => `${v.toLocaleString('hu-HU', { maximumFractionDigits: 1 })}%`;
const ref = (v: number) => v.toLocaleString('hu-HU', { maximumFractionDigits: 2 });
const money = (m: { keys: number; metal: number } | null, fallbackKeys: number) =>
  m ? [m.keys ? `${m.keys} kulcs` : '', m.metal || !m.keys ? `${ref(m.metal)} ref` : ''].filter(Boolean).join(' + ') : keys(fallbackKeys);
const link = (label: string, url: string | null | undefined) => (url ? `[${label}](${url})` : null);

function analysisOpportunity(r: AnalysisResult, bptfUrl: string): Opportunity {
  const m = r.bestRoute.source === 'mannco' ? r.alternative : null;
  const sell = `backpack.tf hirdetéssel ${money(r.prices.targetSell, r.prices.targetSellKeys)}`;
  return {
    kind: 'analysis',
    key: r.sku,
    name: r.itemName,
    buy: m
      ? `mannco.store ${usd(m.price)} (≈ ${keys(m.buyKeys)}, ${m.stock} db)`
      : `backpack.tf buy orderrel legfeljebb ${money(r.prices.maxBuyPrice, r.prices.maxBuyPriceKeys)}`,
    sell,
    profitKeys: m ? m.profit.conservativeProfitKeys : r.profit.conservativeProfitKeys,
    marginPercent: m ? m.profit.conservativeMarginPercent : r.profit.conservativeMarginPercent,
    note: r.sales?.expectedDaysToSell != null ? `eladás kb. ${r.sales.expectedDaysToSell} nap` : undefined,
    unusual: qualitiesOf(r.sku).includes('unusual'),
    links: [link('backpack.tf', bptfUrl), link('mannco.store', r.alternative?.url)].filter(Boolean).join(' · '),
  };
}

function dealOpportunity(d: Deal): Opportunity {
  const leg = (l: Deal['buy']) =>
    `${l.market === 'mannco' ? 'mannco.store' : 'backpack.tf'} ${l.usd !== null ? `${usd(l.usd)} (≈ ${keys(l.keys)})` : keys(l.keys)}`;
  return {
    kind: 'deal',
    key: d.id,
    name: d.name,
    buy: `${leg(d.buy)} – ${d.buy.action.toLowerCase()}`,
    sell: `${leg(d.sell)} – ${d.sell.action.toLowerCase()}`,
    profitKeys: d.profitKeys,
    marginPercent: d.marginPercent,
    note: d.estimatedFillDays !== null ? `buy order teljesülése kb. ${d.estimatedFillDays} nap` : 'azonnali',
    unusual: qualitiesOf(d.sku).includes('unusual'),
    links: [link('backpack.tf', d.bptfUrl), link('mannco.store', d.manncoUrl)].filter(Boolean).join(' · '),
  };
}

const line = (o: Opportunity, i: number) =>
  `**${i + 1}. ${o.name}** ${o.kind === 'deal' ? '⚡' : '📈'} **+${keys(o.profitKeys)}** (${pct(o.marginPercent)})\n` +
  `🛒 ${o.buy}\n🏷️ ${o.sell}\n` +
  (o.unusual ? '⚠️ Unusual: a pricedb ára becsült érték, vétel előtt nézd meg a backpack.tf hirdetéseket.\n' : '') +
  [o.note, o.links].filter(Boolean).join(' · ');

/**
 * Összefoglaló Discord üzenet egy automatikus keresés után: az újonnan talált vételi lehetőségek (a hosszabb
 * távú elemzésből és az azonnali üzletekből), haszon szerint csökkenő sorrendben, a legjobb MAX_LINES részletesen.
 * Csak az előző összefoglaló óta új tételekről szól; a beállított ár- és típusszűrőt és a tárgyankénti
 * kikapcsolást figyelembe veszi. Visszaadja, hány új lehetőségről szólt (0, ha nem ment üzenet).
 */
export async function sendScanDigest(input: {
  results: AnalysisEntry[];
  deals: Deal[];
  prefs: NotificationPreferences;
  filter: MarketFilter;
  bptfUrlFor: (sku: string, name: string) => string;
}): Promise<number> {
  const { results, deals, prefs, filter, bptfUrlFor } = input;
  const muted = (sku: string) => prefs.items[sku]?.notify === false;

  const buys = results
    .filter((r): r is AnalysisResult => 'bestRoute' in r && r.bestRoute.recommendation === 'BUY')
    .filter((r) => !muted(r.sku))
    .filter((r) => {
      const buyKeys = r.bestRoute.source === 'mannco' && r.alternative ? r.alternative.buyKeys : r.prices.currentBuyKeys;
      return matchesFilter(filter, r.sku, buyKeys);
    });
  const goodDeals = deals.filter((d) => d.recommendation === 'BUY' && !muted(d.sku));

  const previous = await store.read<DigestState | null>(FILE, null);
  const seenBuys = new Set(previous?.buys ?? []);
  const seenDeals = new Set(previous?.deals ?? []);
  const fresh: Opportunity[] = [
    ...buys.filter((r) => !seenBuys.has(r.sku)).map((r) => analysisOpportunity(r, bptfUrlFor(r.sku, r.itemName))),
    ...goodDeals.filter((d) => !seenDeals.has(d.id)).map(dealOpportunity),
  ].sort((a, b) => b.profitKeys - a.profitKeys);

  let sent = 0;
  if (fresh.length > 0 && prefs.notifyAllBuys && discordService.isConfigured) {
    const lines: string[] = [];
    let length = 0;
    for (const [i, o] of fresh.slice(0, MAX_LINES).entries()) {
      const text = line(o, i);
      if (length + text.length + 2 > MAX_DESCRIPTION) break;
      lines.push(text);
      length += text.length + 2;
    }
    const rest = fresh.length - lines.length;
    const analysisCount = fresh.filter((o) => o.kind === 'analysis').length;
    try {
      await discordService.send({
        title: `🔎 ${fresh.length} új vételi lehetőség`,
        description: lines.join('\n\n') + (rest > 0 ? `\n\n…és még ${rest} további – a többit az appban látod.` : ''),
        color: COLORS.buy,
        footer: {
          text: `${analysisCount} hosszabb távú (📈) · ${fresh.length - analysisCount} azonnali üzlet (⚡) · ` +
            `összesen ${buys.length + goodDeals.length} ajánlott`,
        },
        timestamp: new Date().toISOString(),
      });
      sent = fresh.length;
    } catch (error) {
      // Sikertelen küldésnél nem frissítjük az állapotot, így a következő keresés újrapróbálja
      console.warn(`[digest] Az összefoglaló küldése sikertelen: ${(error as Error).message}`);
      return 0;
    }
  }

  // Ha az összefoglaló ki van kapcsolva, akkor is megjegyezzük, mit láttunk, hogy bekapcsoláskor ne a régieket küldje
  await store.write(FILE, {
    sentAt: new Date().toISOString(),
    buys: buys.map((r) => r.sku),
    deals: goodDeals.map((d) => d.id),
  } satisfies DigestState);
  return sent;
}

/** Elfelejti, miről szólt már az összefoglaló; a következő keresés minden mostani lehetőségről szól. */
export function resetScanDigest() {
  return store.remove(FILE);
}

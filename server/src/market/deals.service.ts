import { KEY_SKU, config, envAnalysisOptions } from '../config';
import { discordService, COLORS } from '../notifications/discord.service';
import { Check, DEFAULT_OPTIONS } from '../services/arbitrage.service';
import { FileStore } from '../storage/file.store';
import { MarketFilter, filterService, matchesFilter, qualitiesOf } from './filter.service';
import { bptfStatsUrl } from './bptf-link';
import { manncoService } from './mannco.service';
import { Quote, ScreenContext } from './screener.service';

/**
 * Azonnali (tartás nélküli) üzlettípusok a két piac között:
 * - MANNCO_TO_BPTF: a mannco legolcsóbb ajánlatát megveszed, és azonnal eladod a backpack.tf botoknak a buy order árukon;
 * - MANNCO_ORDER_TO_BPTF: buy ordert teszel a mannco-n 1 centtel a legmagasabb fölé, és teljesülés után eladod a botoknak;
 * - BPTF_TO_MANNCO_ORDER: a backpack.tf-en megveszed (a botok eladási árán), és eladod a legmagasabb mannco buy ordernek (5% díj).
 */
export type DealType = 'MANNCO_TO_BPTF' | 'MANNCO_ORDER_TO_BPTF' | 'BPTF_TO_MANNCO_ORDER';

export interface DealLeg {
  market: 'bptf' | 'mannco';
  /** Mit csinálsz ezen a lábon (megjelenítéshez). */
  action: string;
  keys: number;
  /** A mannco lábon az ár dollárban. */
  usd: number | null;
}

export interface Deal {
  id: string;
  type: DealType;
  sku: string;
  name: string;
  buy: DealLeg;
  sell: DealLeg;
  /** A jelenlegi árakkal, minden díj után, kulcsban. */
  profitKeys: number;
  marginPercent: number;
  /** A backpack.tf láb legrosszabb ára a napi pillanatképekben – ennyi a haszon, ha a bptf ár visszaesne. */
  worstProfitKeys: number;
  recommendation: 'BUY' | 'WATCH';
  checks: Check[];
  /** A mannco-n elérhető darabszám (azonnali mannco vételnél). */
  stock: number | null;
  /** Saját buy ordernél: a teljesülésig becsült idő napban a tényleges mannco eladásokból (null: nincs adat). */
  estimatedFillDays: number | null;
  manncoUrl: string | null;
  /** A tárgy backpack.tf statisztika-oldala. */
  bptfUrl: string;
  /** Saját buy ordernél: a javasolt ár alapja (a mostani legmagasabb buy order és a tényleges eladások). */
  order: {
    topBidUsd: number;
    priceUsd: number;
    soldAtOrBelow: number | null;
    windowDays: number | null;
    /** A javasolt ár a tényleges eladásokból jön (nem csak 1 centtel a legmagasabb fölött). */
    fromSales: boolean;
  } | null;
  bptfPriceAgeHours: number;
  manncoDataAgeMinutes: number;
}

export interface DealsFile {
  generatedAt: string;
  keyPriceUsd: number | null;
  /** Hány tárgynak ismerjük a friss (6 óránál újabb) mannco buy orderét a párosítottak közül. */
  coverage: { matched: number; bidsFresh: number };
  deals: Deal[];
}

const FILE = 'deals.json';
const NOTIFIED_FILE = 'deals-notified.json';
const STORE_URL = 'https://mannco.store/item/';
/** A mannco eladási díja (buy ordernek eladáskor az eladó a 95%-ot kapja). */
const MANNCO_SELL_FEE = 0.05;
/** Azonnali üzletnél a botok ára legfeljebb ennyi órás lehet. */
const MAX_BPTF_AGE_HOURS = 24;
/** A mannco buy order adat legfeljebb ennyi órás lehet. */
const MAX_BID_AGE_HOURS = 6;
/** A két piac ára ennyiszeres eltérésen belül kell legyen, különben valószínűleg eltérő változat vagy rossz párosítás. */
const MAX_CROSS_PRICE_RATIO = 2;
/**
 * Ennyi különböző időpontú bptf árbejegyzés kell a jelenlegi árlistában és a napi pillanatképekben együtt
 * (ugyanaz a szabály, mint az előszűrőben). A ritkán frissülő ár mellett a botok nem biztos, hogy ennyiért kereskednek.
 */
const MIN_DISTINCT_UPDATES = 4;
/** Futásonként legfeljebb ennyi tárgy eladási adatát kérjük le a saját buy orderes üzletek teljesülési idejéhez. */
const MAX_SALES_LOOKUPS = 100;

const round = (v: number, digits = 3) => (Number.isFinite(v) ? parseFloat(v.toFixed(digits)) : 0);
const check = (id: string, category: Check['category'], passed: boolean, value: number, threshold: number, message: string): Check =>
  ({ id, category, passed, value: round(value), threshold, message });

export const DEAL_LABELS: Record<DealType, string> = {
  MANNCO_TO_BPTF: 'mannco vétel → bptf quicksell',
  MANNCO_ORDER_TO_BPTF: 'mannco buy order → bptf quicksell',
  BPTF_TO_MANNCO_ORDER: 'bptf vétel → mannco buy order',
};

/**
 * Azonnali üzletek keresése a backpack.tf (pricedb) és a mannco.store között. A mannco buy ordereket nem lehet
 * egyszerre minden tárgyra lekérni (percenként ~1000 tárgy), ezért futásonként prioritás szerint frissítjük:
 * előre a legutóbb talált üzletek és a mannco ajánlat alapján ígéretes tárgyak, a többi a legrégebben frissítettel kezdve.
 */
export class DealsService {
  private cache?: DealsFile | null;

  constructor(private store = new FileStore(config.dataDir)) {}

  get(): Promise<DealsFile | null> {
    if (this.cache !== undefined) return Promise.resolve(this.cache);
    return this.store.read<DealsFile | null>(FILE, null).then((file) => (this.cache = file));
  }

  /** Buy orderek frissítése, üzletek keresése, a saját buy orderes üzletek teljesülési idejének becslése és mentés. */
  async run(context: ScreenContext): Promise<DealsFile | null> {
    const offersFile = await manncoService.get();
    if (!manncoService.isConfigured || !offersFile) return null;
    const keyCents = offersFile.keyPriceCents;
    const opts = { ...DEFAULT_OPTIONS, ...envAnalysisOptions() };

    // 1. Buy orderek frissítése prioritás szerint
    const previous = (await this.get())?.deals.map((d) => d.sku) ?? [];
    const promising: { sku: string; potential: number }[] = [];
    const rotation: { sku: string; fetchedAt: number; value: number }[] = [];
    for (const [sku, q] of Object.entries(context.current)) {
      if (sku === KEY_SKU || !this.usable(q, context.at, opts)) continue;
      if (!(await manncoService.hasItem(sku))) continue;
      const offer = offersFile.offers[sku];
      // A buy order legfeljebb a legolcsóbb ajánlat, így ebből felülről becsülhető a bptf → mannco üzlet haszna
      if (offer) {
        const potential = (offer.priceCents * (1 - MANNCO_SELL_FEE)) / keyCents - q[1];
        if (potential >= opts.minProfitKeys) promising.push({ sku, potential });
      }
      const bid = await manncoService.bidFor(sku);
      rotation.push({ sku, fetchedAt: bid ? Date.parse(bid.fetchedAt) : 0, value: q[0] });
    }
    promising.sort((a, b) => b.potential - a.potential);
    rotation.sort((a, b) => a.fetchedAt - b.fetchedAt || b.value - a.value);
    const updated = await manncoService.refreshBids(
      [...previous, ...promising.map((p) => p.sku), ...rotation.map((r) => r.sku)],
      config.mannco.bidRequestsPerRun,
    );

    // 2. Üzletek keresése; a saját buy orderes üzletekhez kell az eladási sebesség, ezt utána pótoljuk és újraszámolunk
    let deals = await this.findDeals(context, keyCents, await filterService.get());
    // A reális buy order árhoz a napi eladások kellenek; ahol még nincsenek meg, letöltjük, és újraszámolunk
    const needSales: string[] = [];
    for (const d of deals) {
      if (d.type === 'MANNCO_ORDER_TO_BPTF' && !(await manncoService.hasSalesDays(d.sku))) needSales.push(d.sku);
    }
    if (needSales.length > 0 && (await manncoService.refreshSales(needSales.slice(0, MAX_SALES_LOOKUPS))) > 0) {
      deals = await this.findDeals(context, keyCents, await filterService.get());
    }

    let bidsFresh = 0;
    for (const r of rotation) {
      const bid = await manncoService.bidFor(r.sku);
      if (bid && Date.now() - Date.parse(bid.fetchedAt) <= MAX_BID_AGE_HOURS * 3_600_000) bidsFresh++;
    }
    const file: DealsFile = {
      generatedAt: new Date().toISOString(),
      keyPriceUsd: keyCents / 100,
      coverage: { matched: rotation.length, bidsFresh },
      deals,
    };
    await this.store.write(FILE, file);
    this.cache = file;
    const buys = deals.filter((d) => d.recommendation === 'BUY').length;
    console.log(
      `[deals] ${updated} buy order frissítve (${bidsFresh}/${rotation.length} friss); ` +
      `${deals.length} üzlet, ebből ${buys} ajánlott.`,
    );
    return file;
  }

  /** Használható-e a bptf ár: van vétel és eladás, nem régebbi az elemzés korhatáránál, és nem irreális az árrés. */
  private usable(q: Quote, now: number, opts: { maxDataAgeHours: number; maxSpreadPercent: number }) {
    return q[0] > 0 && q[1] > 0 && now - q[2] <= opts.maxDataAgeHours * 3600 && q[1] <= q[0] * (1 + opts.maxSpreadPercent / 100);
  }

  private async findDeals(context: ScreenContext, keyCents: number, filter: MarketFilter): Promise<Deal[]> {
    const offersFile = await manncoService.get();
    const opts = { ...DEFAULT_OPTIONS, ...envAnalysisOptions() };
    const deals: Deal[] = [];

    for (const [sku, q] of Object.entries(context.current)) {
      if (sku === KEY_SKU || !this.usable(q, context.at, opts)) continue;
      const offer = offersFile?.offers[sku];
      const bid = await manncoService.bidFor(sku);
      if (!offer && !bid) continue;

      const name = context.names.get(sku) ?? sku;
      const ids = await manncoService.idsFor(sku);
      const past = context.snapshots.map((s) => s.quotes[sku]);
      const persistent = past.every(Boolean);
      const bptfAgeHours = (context.at - q[2]) / 3600;
      const updates = new Set([q, ...past.filter(Boolean)].map((p) => p![2])).size;
      const neededUpdates = Math.min(MIN_DISTINCT_UPDATES, context.snapshots.length + 1);
      const isUnusual = qualitiesOf(sku).includes('unusual');
      // A bptf láb legrosszabb ára a jelenlegi és a napi pillanatképek közül
      const worstBotBuy = persistent ? Math.min(q[0], ...past.map((p) => p![0])) : 0;
      const worstBotSell = persistent ? Math.max(q[1], ...past.map((p) => p![1])) : Infinity;

      const base = {
        sku, name,
        manncoUrl: ids ? STORE_URL + ids.url : null,
        bptfUrl: bptfStatsUrl(sku, name, context.names),
        bptfPriceAgeHours: round(bptfAgeHours, 1),
      };
      const addDeal = (deal: Omit<Deal, keyof typeof base | 'id' | 'recommendation' | 'marginPercent' | 'checks'>, extra: Check[]) => {
        const marginPercent = deal.buy.keys > 0 ? (deal.profitKeys / deal.buy.keys) * 100 : 0;
        if (deal.profitKeys < opts.minProfitKeys || marginPercent < opts.minMarginPercent) return;
        if (!matchesFilter(filter, sku, deal.buy.keys)) return;
        const checks: Check[] = [
          check('PROFIT', 'profit', true, deal.profitKeys, opts.minProfitKeys,
            `Haszon a jelenlegi árakkal, díjak után: ${round(deal.profitKeys)} kulcs (${round(marginPercent, 1)}%).`),
          check('PERSISTENCE', 'risk', deal.worstProfitKeys >= opts.minProfitKeys, deal.worstProfitKeys, opts.minProfitKeys,
            persistent
              ? `A backpack.tf ár az elmúlt ${context.snapshots.length} nap napi pillanatképei alapján legrosszabb esetben ` +
                `${round(deal.worstProfitKeys)} kulcs hasznot hagyna, legalább ${opts.minProfitKeys} kell.`
              : 'A tárgy nem szerepelt minden napi pillanatképben, így nem látszik, hogy a backpack.tf ár tartós-e.'),
          check('BPTF_FRESHNESS', 'data', bptfAgeHours <= MAX_BPTF_AGE_HOURS, bptfAgeHours, MAX_BPTF_AGE_HOURS,
            `A backpack.tf ár ${round(bptfAgeHours, 1)} órás, azonnali üzlethez legfeljebb ${MAX_BPTF_AGE_HOURS} órás lehet.`),
          check('BPTF_ACTIVITY', 'risk', updates >= neededUpdates, updates, neededUpdates,
            `A backpack.tf ár az elmúlt ${context.snapshots.length} napban ${updates} különböző időpontban frissült, legalább ` +
            `${neededUpdates} kell. A ritkán frissülő ár inkább becslés, a botok nem biztos, hogy ennyiért kereskednek.`),
          ...(isUnusual ? [check('UNUSUAL_PRICE', 'risk', false, 0, 0,
            'Unusual tárgy: a pricedb ára becsült érték, a botok ritkán kereskednek unusualokkal ezen az áron. ' +
            'Vétel előtt nézd meg a tényleges backpack.tf hirdetéseket.')] : []),
          ...extra,
        ];
        deals.push({
          ...base, ...deal,
          id: `${deal.type}:${sku}`,
          profitKeys: round(deal.profitKeys),
          worstProfitKeys: round(deal.worstProfitKeys),
          marginPercent: round(marginPercent, 1),
          checks,
          recommendation: checks.every((c) => c.passed) ? 'BUY' : 'WATCH',
        });
      };
      const crossCheck = (manncoKeys: number, bptfKeys: number) => {
        const ratio = bptfKeys > 0 ? manncoKeys / bptfKeys : Infinity;
        return check('PRICE_SANITY', 'risk', ratio >= 1 / MAX_CROSS_PRICE_RATIO && ratio <= MAX_CROSS_PRICE_RATIO, ratio, MAX_CROSS_PRICE_RATIO,
          `A mannco ár a backpack.tf ár ${round(ratio * 100, 0)}%-a; ${round(100 / MAX_CROSS_PRICE_RATIO, 0)}–${MAX_CROSS_PRICE_RATIO * 100}% ` +
          'között elfogadható, ezen kívül valószínűleg eltérő változat (festék, spell, effekt) vagy rossz párosítás.');
      };
      const bidAgeHours = bid ? (Date.now() - Date.parse(bid.fetchedAt)) / 3_600_000 : Infinity;
      const bidFresh = check('MANNCO_FRESHNESS', 'data', bidAgeHours <= MAX_BID_AGE_HOURS, bidAgeHours, MAX_BID_AGE_HOURS,
        `A mannco buy order adat ${round(bidAgeHours, 1)} órás, legfeljebb ${MAX_BID_AGE_HOURS} órás lehet.`);

      // A) Azonnali mannco vétel → bptf quicksell
      if (offer) {
        const buyKeys = offer.priceCents / keyCents;
        addDeal({
          type: 'MANNCO_TO_BPTF',
          buy: { market: 'mannco', action: 'Megveszed a legolcsóbb ajánlatot', keys: round(buyKeys), usd: offer.priceCents / 100 },
          sell: { market: 'bptf', action: 'Eladod a botoknak (buy order áron)', keys: round(q[0]), usd: null },
          profitKeys: q[0] - buyKeys,
          worstProfitKeys: worstBotBuy - buyKeys,
          stock: offer.stock,
          estimatedFillDays: null,
          order: null,
          manncoDataAgeMinutes: round((Date.now() - Date.parse(offersFile!.fetchedAt)) / 60_000, 0),
        }, [crossCheck(buyKeys, q[0])]);
      }

      if (!bid || !(bid.bidCents > 0)) continue;
      const bidKeysNet = (bid.bidCents * (1 - MANNCO_SELL_FEE)) / keyCents;
      const manncoAge = round((Date.now() - Date.parse(bid.fetchedAt)) / 60_000, 0);

      // B) Saját mannco buy order → bptf quicksell. Az ár nem egyszerűen 1 centtel a legmagasabb buy order fölött: a
      //    tényleges eladásokból a legalacsonyabb olyan ár, amelyen a buy order reálisan teljesül (lásd orderFill).
      //    Felső határ: ahol még megvan a minimális haszon, és olcsóbb a legolcsóbb ajánlatnál (különben azt vennéd meg).
      const minCents = bid.bidCents + 1;
      const lowestSale = offer?.priceCents ?? bid.lowestSaleCents ?? Infinity;
      const maxProfitableCents = Math.floor(Math.min(
        (keyCents * q[0]) / (1 + opts.minMarginPercent / 100),
        keyCents * (q[0] - opts.minProfitKeys),
      ));
      const maxCents = Math.min(maxProfitableCents, lowestSale - 1);
      if (maxCents >= minCents) {
        const fill = await manncoService.orderFill(sku, minCents, maxCents, opts.maxDaysToSell);
        const priceCents = fill?.priceCents ?? minCents;
        const buyKeys = priceCents / keyCents;
        const topBid = (bid.bidCents / 100).toFixed(2);
        const fillCheck = !fill
          ? check('FILL_TIME', 'data', false, 0, opts.maxDaysToSell,
            'Még nincs mannco eladási adat, így nem becsülhető, milyen áron és mikor teljesülne a buy order.')
          : check('FILL_TIME', 'risk', fill.reachedTarget, Math.min(fill.fillDays ?? 9999, 9999), opts.maxDaysToSell,
            fill.reachedTarget
              ? `Az elmúlt ${fill.windowDays} napban ${fill.soldAtOrBelow} darab kelt el a mannco-n ${(priceCents / 100).toFixed(2)} $-ért ` +
                `vagy olcsóbban, így ezen az áron a buy order kb. ${round(fill.fillDays!, 1)} nap alatt teljesülhet (a legmagasabb most ${topBid} $).`
              : fill.fillDays === null
                ? `Az elmúlt ${fill.windowDays} napban a még nyereséges ${(priceCents / 100).toFixed(2)} $-ért vagy olcsóbban egy darab sem kelt el, ` +
                  'így a buy order valószínűleg nem teljesülne.'
                : `A még nyereséges legmagasabb áron (${(priceCents / 100).toFixed(2)} $) is csak ${fill.soldAtOrBelow} darab kelt el az elmúlt ` +
                  `${fill.windowDays} napban, így a teljesülés kb. ${round(fill.fillDays, 1)} nap, legfeljebb ${opts.maxDaysToSell} nap lehet.`);
        addDeal({
          type: 'MANNCO_ORDER_TO_BPTF',
          buy: {
            market: 'mannco',
            action: fill && priceCents > minCents ? `Buy order reális áron (a legmagasabb most ${topBid} $)` : 'Buy order 1 centtel a legmagasabb fölé',
            keys: round(buyKeys),
            usd: priceCents / 100,
          },
          sell: { market: 'bptf', action: 'Eladod a botoknak (buy order áron)', keys: round(q[0]), usd: null },
          profitKeys: q[0] - buyKeys,
          worstProfitKeys: worstBotBuy - buyKeys,
          stock: null,
          estimatedFillDays: fill?.fillDays == null ? null : round(fill.fillDays, 1),
          order: {
            topBidUsd: bid.bidCents / 100,
            priceUsd: priceCents / 100,
            soldAtOrBelow: fill?.soldAtOrBelow ?? null,
            windowDays: fill?.windowDays ?? null,
            fromSales: !!fill && priceCents > minCents,
          },
          manncoDataAgeMinutes: manncoAge,
        }, [bidFresh, crossCheck(buyKeys, q[0]), fillCheck]);
      }

      // C) bptf vétel → eladás a legmagasabb mannco buy ordernek (5% díj)
      addDeal({
        type: 'BPTF_TO_MANNCO_ORDER',
        buy: { market: 'bptf', action: 'Megveszed a botoktól (eladási áron)', keys: round(q[1]), usd: null },
        sell: { market: 'mannco', action: 'Eladod a legmagasabb buy ordernek (5% díj)', keys: round(bidKeysNet), usd: bid.bidCents / 100 },
        profitKeys: bidKeysNet - q[1],
        worstProfitKeys: bidKeysNet - worstBotSell,
        stock: null,
        estimatedFillDays: null,
        order: null,
        manncoDataAgeMinutes: manncoAge,
      }, [bidFresh, crossCheck(bid.bidCents / keyCents, q[1])]);
    }

    return deals.sort((a, b) => Number(b.recommendation === 'BUY') - Number(a.recommendation === 'BUY') || b.profitKeys - a.profitKeys);
  }

  /**
   * Discord értesítés az újonnan megjelent ajánlott üzletekről azoknál a tárgyaknál, amelyekre értesítést kérsz.
   * Egy üzletről csak egyszer szól; ha eltűnik, majd újra megjelenik, újra szól. Visszaadja az elküldött üzenetek számát.
   */
  async notify(file: DealsFile, shouldNotify: (sku: string) => Promise<boolean>): Promise<number> {
    const notified = await this.store.read<Record<string, string>>(NOTIFIED_FILE, {});
    const current = new Set(file.deals.filter((d) => d.recommendation === 'BUY').map((d) => d.id));
    let sent = 0;
    for (const deal of file.deals) {
      if (deal.recommendation !== 'BUY' || notified[deal.id] || !discordService.isConfigured) continue;
      if (!(await shouldNotify(deal.sku))) continue;
      try {
        await discordService.send(dealEmbed(deal));
        notified[deal.id] = new Date().toISOString();
        sent++;
      } catch (error) {
        console.warn(`[deals] ${deal.id} értesítése sikertelen: ${(error as Error).message}`);
      }
    }
    for (const id of Object.keys(notified)) if (!current.has(id)) delete notified[id];
    await this.store.write(NOTIFIED_FILE, notified);
    return sent;
  }
}

const legText = (leg: DealLeg) => `${leg.usd !== null ? `${leg.usd.toFixed(2)} $ ≈ ` : ''}${leg.keys} kulcs`;

const dealEmbed = (deal: Deal) => ({
  title: `⚡ Azonnali üzlet: ${deal.name}`,
  url: deal.manncoUrl ?? undefined,
  description: DEAL_LABELS[deal.type],
  color: COLORS.buy,
  fields: [
    { name: `Vétel (${deal.buy.market === 'mannco' ? 'mannco.store' : 'backpack.tf'})`, value: `${deal.buy.action}: ${legText(deal.buy)}`, inline: false },
    { name: `Eladás (${deal.sell.market === 'mannco' ? 'mannco.store' : 'backpack.tf'})`, value: `${deal.sell.action}: ${legText(deal.sell)}`, inline: false },
    { name: 'Haszon', value: `${deal.profitKeys} kulcs (${deal.marginPercent}%) · legrosszabb esetben ${deal.worstProfitKeys} kulcs`, inline: false },
    ...(deal.estimatedFillDays !== null ? [{ name: 'Becsült teljesülés', value: `kb. ${deal.estimatedFillDays} nap`, inline: true }] : []),
    {
      name: 'Linkek',
      value: [`[backpack.tf](${deal.bptfUrl})`, deal.manncoUrl ? `[mannco.store](${deal.manncoUrl})` : null].filter(Boolean).join(' · '),
      inline: false,
    },
  ],
  footer: { text: `SKU: ${deal.sku}` },
});

export const dealsService = new DealsService();

import { Request, Response } from 'express';
import { AnalysisResult, collectorService } from '../collector/collector.service';
import { discordService } from '../notifications/discord.service';
import { bptfStatsUrl, namesIndex } from '../market/bptf-link';
import { QUALITIES, filterService, isQuality, matchesFilter, qualitiesOf } from '../market/filter.service';
import { manncoService } from '../market/mannco.service';
import { preferencesService } from '../notifications/preferences.service';

// GET /api/market – az elemzett tárgyak (előszűrés jelöltjei + értesítésre jelöltek) óvatos haszon szerint csökkenő sorrendben
export const getMarket = async (_req: Request, res: Response) => {
  try {
    const [analysis, screen, states, prefs, filter, itemList] = await Promise.all([
      collectorService.getAnalysis(),
      collectorService.getLastScreen(),
      collectorService.getSkuStates(),
      preferencesService.get(),
      filterService.get(),
      collectorService.getItems(),
    ]);
    const names = namesIndex(itemList);
    const results = new Map((analysis?.results ?? []).map((r) => [r.sku, r]));
    const candidates = new Map((screen?.candidates ?? []).map((c) => [c.sku, c]));
    const notified = Object.entries(prefs.items).filter(([, p]) => p.notify).map(([sku]) => sku);
    const skus = new Set([...results.keys(), ...notified, ...candidates.keys()]);

    const all = [...skus].map((sku) => {
      const entry = results.get(sku);
      const result = entry && 'recommendation' in entry ? (entry as AnalysisResult) : null;
      const candidate = candidates.get(sku);
      const state = states[sku];
      return {
        sku,
        name: result?.itemName ?? candidate?.name ?? prefs.items[sku]?.name ?? sku,
        qualities: qualitiesOf(sku),
        bptfUrl: bptfStatsUrl(sku, result?.itemName ?? names.get(sku) ?? candidate?.name ?? sku, names),
        notify: prefs.items[sku]?.notify ?? prefs.notifyAllBuys,
        analysis: result,
        error: entry && 'error' in entry ? entry.error : state?.lastError ?? null,
        lastFetchedAt: state?.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
        screen: candidate
          ? {
            route: candidate.route ?? 'bptf',
            buyKeys: candidate.buyKeys,
            sellKeys: candidate.sellKeys,
            profitKeys: candidate.profitKeys,
            marginPercent: candidate.marginPercent,
          }
          : null,
      };
    });

    // A szűrő a már elemzett, de a mostani szűrőn kívül eső tárgyakat (pl. a korábbi vételi ajánlatokat) is elrejti;
    // az ár nélküli (még elemzésre váró, saját kérésű) tárgyakat csak a típusuk szerint szűrjük
    const items = all.filter((i) => {
      const buyKeys = (i.analysis && bestBuyKeys(i.analysis)) ?? i.screen?.buyKeys;
      return buyKeys === undefined
        ? matchesFilter({ ...filter, minKeys: null, maxKeys: null }, i.sku, 0)
        : matchesFilter(filter, i.sku, buyKeys);
    });

    // Elöl az elemzettek a legjobb útvonal óvatos haszna szerint, utánuk a még elemzésre várók a jelenlegi árrés szerint
    const profit = (i: (typeof items)[number]) => (i.analysis ? bestProfitKeys(i.analysis) : -Infinity);
    items.sort((a, b) =>
      Number(!a.analysis) - Number(!b.analysis) ||
      profit(b) - profit(a) ||
      (b.screen?.profitKeys ?? -Infinity) - (a.screen?.profitKeys ?? -Infinity));

    return res.json({
      items,
      analyzedAt: analysis?.analyzedAt ?? null,
      keyPriceMetal: analysis?.keyPriceMetal ?? screen?.keyPriceMetal ?? null,
      screen: screen
        ? {
          screenedAt: screen.screenedAt,
          scanned: screen.scanned,
          profitableNow: screen.profitableNow,
          persistent: screen.persistent,
          candidates: screen.candidates.length,
        }
        : null,
      mannco: {
        configured: manncoService.isConfigured,
        matched: screen?.mannco?.matched ?? null,
        profitableNow: screen?.mannco?.profitableNow ?? null,
        keyPriceUsd: screen?.mannco?.keyPriceUsd ?? null,
      },
      filter,
      hiddenByFilter: all.length - items.length,
      /** Az előszűrés még a korábbi szűrővel készült (a szűrő után indított gyűjtés még fut). */
      filterPending: !!screen && JSON.stringify(screen.filter ?? null) !== JSON.stringify(filter),
      qualities: Object.entries(QUALITIES).map(([id, q]) => ({ id, label: q.label })),
      collector: { running: collectorService.isRunning },
      discord: { configured: discordService.isConfigured },
      notifications: { notifyAllBuys: prefs.notifyAllBuys },
    });
  } catch (error) {
    console.error('Piaci lista hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

// A korábbi (mannco előtti) elemzésekben még nincs bestRoute; ilyenkor a backpack.tf útvonal számít
const bestProfitKeys = (a: AnalysisResult) => a.bestRoute?.conservativeProfitKeys ?? a.profit.conservativeProfitKeys;
const bestBuyKeys = (a: AnalysisResult) =>
  a.bestRoute?.source === 'mannco' && a.alternative ? a.alternative.buyKeys : a.prices.currentBuyKeys;

const parseKeys = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// PUT /api/market/filter { minKeys, maxKeys, qualities } – vételi ár (kulcs) és típus szerinti szűrő. Az előszűrés
// ezután csak a megfelelő tárgyak közül választ jelölteket, ezért a szűrő mentése új gyűjtést indít.
export const updateFilter = async (req: Request, res: Response) => {
  try {
    const minKeys = parseKeys(req.body?.minKeys);
    const maxKeys = parseKeys(req.body?.maxKeys);
    const qualities: unknown = req.body?.qualities ?? [];
    if (minKeys === undefined || maxKeys === undefined) {
      return res.status(400).json({ error: 'A minKeys és a maxKeys nemnegatív szám vagy null kell legyen.' });
    }
    if (minKeys !== null && maxKeys !== null && minKeys > maxKeys) {
      return res.status(400).json({ error: 'A minimális ár nem lehet nagyobb a maximálisnál.' });
    }
    if (!Array.isArray(qualities) || !qualities.every(isQuality)) {
      return res.status(400).json({ error: `Ismeretlen típus. Választható: ${Object.keys(QUALITIES).join(', ')}.` });
    }

    const filter = await filterService.set({ minKeys, maxKeys, qualities: [...new Set(qualities)] });
    void collectorService.run('szűrő változott', true);
    return res.json(filter);
  } catch (error) {
    console.error('Szűrő mentési hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';
import { bptfStatsUrl, namesIndex } from '../market/bptf-link';
import { DEAL_LABELS, dealsService } from '../market/deals.service';
import { filterService, matchesFilter } from '../market/filter.service';
import { manncoService } from '../market/mannco.service';
import { preferencesService } from '../notifications/preferences.service';

// GET /api/deals – azonnali üzletek a backpack.tf és a mannco.store között (ajánlottak elöl, haszon szerint csökkenő sorrendben)
export const getDeals = async (_req: Request, res: Response) => {
  try {
    const [file, filter, prefs, itemList] = await Promise.all([
      dealsService.get(), filterService.get(), preferencesService.get(), collectorService.getItems(),
    ]);
    const names = namesIndex(itemList);
    // A szűrő a mentett üzletekre is érvényes, ha azóta változott
    const deals = (file?.deals ?? [])
      .filter((d) => matchesFilter(filter, d.sku, d.buy.keys))
      .map((d) => ({
        ...d,
        notify: prefs.items[d.sku]?.notify ?? prefs.notifyAllBuys,
        bptfUrl: bptfStatsUrl(d.sku, names.get(d.sku) ?? d.name, names),
      }));
    return res.json({
      configured: manncoService.isConfigured,
      generatedAt: file?.generatedAt ?? null,
      keyPriceUsd: file?.keyPriceUsd ?? null,
      coverage: file?.coverage ?? null,
      labels: DEAL_LABELS,
      deals,
    });
  } catch (error) {
    console.error('Üzletlista hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

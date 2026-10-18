import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';
import { discordService } from '../notifications/discord.service';
import { trackingService } from '../tracking/tracking.service';

const serverError = (res: Response, error: unknown) => {
  console.error('Követett tárgyak hiba:', error);
  return res.status(500).json({ error: 'Belső szerverhiba történt' });
};

// GET /api/tracked – a követett tárgyak a legutóbbi elemzéssel és a letöltés állapotával (legjobb ajánlatok elöl)
export const listTracked = async (_req: Request, res: Response) => {
  try {
    const [tracked, analysis, states] = await Promise.all([
      trackingService.list(),
      collectorService.getAnalysis(),
      collectorService.getSkuStates(),
    ]);
    const results = analysis?.results ?? [];
    const order = new Map(results.map((r, i) => [r.sku, i]));

    const items = tracked
      .map((item) => {
        const entry = results.find((r) => r.sku === item.sku);
        const state = states[item.sku];
        return {
          ...item,
          analysis: entry && 'recommendation' in entry ? entry : null,
          error: entry && 'error' in entry ? entry.error : state?.lastError ?? null,
          lastFetchedAt: state?.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
        };
      })
      .sort((a, b) => (order.get(a.sku) ?? Infinity) - (order.get(b.sku) ?? Infinity));

    return res.json({
      items,
      analyzedAt: analysis?.analyzedAt ?? null,
      keyPriceMetal: analysis?.keyPriceMetal ?? null,
      collector: { running: collectorService.isRunning },
      discord: { configured: discordService.isConfigured },
    });
  } catch (error) {
    return serverError(res, error);
  }
};

// POST /api/tracked { sku, notify? } – új tárgy követése; a gyűjtő azonnal letölti a history-ját
export const addTracked = async (req: Request, res: Response) => {
  try {
    const sku = typeof req.body?.sku === 'string' ? req.body.sku.trim() : '';
    if (!sku) return res.status(400).json({ error: 'Hiányzik az SKU.' });

    const items = await collectorService.getItems();
    const known = items.find((i) => i.sku === sku);
    if (items.length > 0 && !known) {
      return res.status(400).json({ error: `Ismeretlen SKU: ${sku} nem szerepel a pricedb.io tárgylistájában.` });
    }

    const { item, created } = await trackingService.add(sku, known?.name ?? sku, req.body?.notify !== false);
    if (created) void collectorService.run(`új tárgy: ${sku}`, true);
    return res.status(created ? 201 : 200).json(item);
  } catch (error) {
    return serverError(res, error);
  }
};

// PATCH /api/tracked/:sku { notify }
export const updateTracked = async (req: Request, res: Response) => {
  try {
    if (typeof req.body?.notify !== 'boolean') {
      return res.status(400).json({ error: 'A notify mező true vagy false kell legyen.' });
    }
    const item = await trackingService.update(String(req.params.sku), { notify: req.body.notify });
    return item ? res.json(item) : res.status(404).json({ error: 'Nem követett tárgy.' });
  } catch (error) {
    return serverError(res, error);
  }
};

// DELETE /api/tracked/:sku
export const removeTracked = async (req: Request, res: Response) => {
  try {
    const removed = await trackingService.remove(String(req.params.sku));
    return removed ? res.status(204).end() : res.status(404).json({ error: 'Nem követett tárgy.' });
  } catch (error) {
    return serverError(res, error);
  }
};

// GET /api/items/search?q=...&limit=20 – keresés a pricedb.io tárgylistájában
export const searchItems = async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    return res.json(await collectorService.searchItems(q, limit));
  } catch (error) {
    return serverError(res, error);
  }
};

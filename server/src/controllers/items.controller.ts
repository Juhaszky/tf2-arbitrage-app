import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';

// GET /api/items/:sku/stats – egy tárgy részletes statisztikája a grafikonokhoz
export const getItemStats = async (req: Request, res: Response) => {
  try {
    const stats = await collectorService.getItemStats(String(req.params.sku));
    return stats ? res.json(stats) : res.status(404).json({ error: 'Ehhez a tárgyhoz még nincs letöltött history.' });
  } catch (error) {
    console.error('Statisztika hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

// GET /api/items/search?q=...&limit=20 – keresés a pricedb.io tárgylistájában
export const searchItems = async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    return res.json(await collectorService.searchItems(q, limit));
  } catch (error) {
    console.error('Keresési hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

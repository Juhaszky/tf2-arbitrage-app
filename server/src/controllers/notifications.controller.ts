import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';
import { discordService } from '../notifications/discord.service';
import { sendTestNotification } from '../notifications/notifier';
import { preferencesService } from '../notifications/preferences.service';
import { resetScanDigest } from '../notifications/scan-digest';

const serverError = (res: Response, error: unknown) => {
  console.error('Értesítési beállítás hiba:', error);
  return res.status(500).json({ error: 'Belső szerverhiba történt' });
};

// GET /api/notifications/status
export const getNotificationStatus = async (_req: Request, res: Response) => {
  try {
    return res.json({ discordConfigured: discordService.isConfigured, ...(await preferencesService.get()) });
  } catch (error) {
    return serverError(res, error);
  }
};

// PUT /api/notifications/settings { notifyAllBuys } – összefoglaló üzenet minden keresés után az új vételi lehetőségekről
export const updateNotificationSettings = async (req: Request, res: Response) => {
  try {
    if (typeof req.body?.notifyAllBuys !== 'boolean') {
      return res.status(400).json({ error: 'A notifyAllBuys mező true vagy false kell legyen.' });
    }
    const { notifyAllBuys } = await preferencesService.setNotifyAllBuys(req.body.notifyAllBuys);
    // Bekapcsoláskor a következő keresés a már meglévő lehetőségekről is szóljon, ne csak az azóta találtakról
    if (notifyAllBuys) await resetScanDigest();
    return res.json({ notifyAllBuys });
  } catch (error) {
    return serverError(res, error);
  }
};

// PUT /api/notifications/items/:sku { notify } – értesítés ki/be egy tárgyra. A bekapcsolt tárgyat a gyűjtő
// akkor is elemzi, ha az előszűrésen kiesne; ha még nincs elemzése, azonnal sorra kerül.
export const updateItemNotification = async (req: Request, res: Response) => {
  try {
    const sku = String(req.params.sku).trim();
    if (typeof req.body?.notify !== 'boolean') {
      return res.status(400).json({ error: 'A notify mező true vagy false kell legyen.' });
    }
    const items = await collectorService.getItems();
    const known = items.find((i) => i.sku === sku);
    if (items.length > 0 && !known) {
      return res.status(400).json({ error: `Ismeretlen SKU: ${sku} nem szerepel a pricedb.io tárgylistájában.` });
    }

    const pref = await preferencesService.setItem(sku, known?.name ?? sku, req.body.notify);
    if (pref.notify) {
      const analyzed = (await collectorService.getAnalysis())?.results.some((r) => r.sku === sku);
      if (!analyzed) void collectorService.run(`értesítés: ${sku}`, true);
    }
    return res.json({ sku, name: pref.name, notify: pref.notify });
  } catch (error) {
    return serverError(res, error);
  }
};

// POST /api/notifications/test – teszt üzenet a Discord csatornára
export const testNotification = async (_req: Request, res: Response) => {
  if (!discordService.isConfigured) {
    return res.status(400).json({ error: 'Nincs beállítva a DISCORD_WEBHOOK_URL a szerver .env fájljában.' });
  }
  try {
    await sendTestNotification();
    return res.json({ message: 'A teszt értesítés elküldve.' });
  } catch (error) {
    console.error('Teszt értesítés hiba:', error);
    return res.status(502).json({ error: (error as Error).message });
  }
};

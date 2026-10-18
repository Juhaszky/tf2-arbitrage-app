import { Request, Response } from 'express';
import { discordService } from '../notifications/discord.service';
import { sendTestNotification } from '../notifications/notifier';

// GET /api/notifications/status
export const getNotificationStatus = (_req: Request, res: Response) =>
  res.json({ discordConfigured: discordService.isConfigured });

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

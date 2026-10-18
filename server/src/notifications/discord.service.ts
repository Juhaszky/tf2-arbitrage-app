import { config } from '../config';

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const COLORS = { buy: 0x2ecc71, neutral: 0x95a5a6, info: 0x3498db };

/** Discord webhook küldő. A webhook rate limitje miatt az üzenetek között szünetet tart. */
export class DiscordService {
  private nextSendAt = 0;

  get isConfigured() {
    return !!config.discordWebhookUrl;
  }

  async send(embed: DiscordEmbed): Promise<void> {
    if (!config.discordWebhookUrl) throw new Error('Nincs beállítva a DISCORD_WEBHOOK_URL.');

    for (let attempt = 1; ; attempt++) {
      const wait = this.nextSendAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextSendAt = Date.now() + 1000;

      const res = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'TF2 Arbitrage', embeds: [{ timestamp: new Date().toISOString(), ...embed }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;

      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(((body.retry_after ?? 2) + 0.5) * 1000);
        continue;
      }
      throw new Error(`Discord webhook hiba: ${res.status} ${await res.text().catch(() => '')}`.trim());
    }
  }
}

export const discordService = new DiscordService();

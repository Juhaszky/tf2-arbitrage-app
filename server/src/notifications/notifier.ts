import type { AnalysisEntry, AnalysisResult } from '../collector/collector.service';
import { config } from '../config';
import { FileStore } from '../storage/file.store';
import type { TrackedItem } from '../tracking/tracking.service';
import { COLORS, discordService } from './discord.service';

const FILE = 'notifications.json';

/** SKU-nként az utoljára látott ajánlás – csak a változásról szólunk. */
type NotificationState = Record<string, { recommendation: string; changedAt: string }>;

const store = new FileStore(config.dataDir);

type Money = { keys: number; metal: number } | null;

const formatPrice = (price: Money, keys: number) =>
  price ? `${price.keys} kulcs ${price.metal ? `+ ${price.metal} ref` : ''}`.trim() : `${keys} kulcs`;

const buyEmbed = (r: AnalysisResult) => ({
  title: `🟢 Vételi lehetőség: ${r.itemName}`,
  description: r.summary,
  color: COLORS.buy,
  fields: [
    { name: 'Max. vételi ár', value: formatPrice(r.prices.maxBuyPrice, r.prices.maxBuyPriceKeys), inline: true },
    { name: 'Javasolt eladási ár', value: formatPrice(r.prices.targetSell, r.prices.targetSellKeys), inline: true },
    {
      name: 'Haszonkulcs',
      value: `óvatos: ${r.profit.conservativeMarginPercent}% · várható: ${r.profit.expectedMarginPercent}%`,
      inline: false,
    },
    { name: 'Jelenlegi ár', value: `vétel ${r.prices.currentBuyKeys} / eladás ${r.prices.currentSellKeys} kulcs`, inline: true },
    {
      name: 'Visszateszt',
      value: `${r.risk.backtestWinRatePercent}% nyerő (${r.risk.backtestIndependentTrades} független ügylet)`,
      inline: true,
    },
  ],
  footer: { text: `SKU: ${r.sku}` },
});

const exitEmbed = (r: AnalysisResult, previous: string) => ({
  title: `⚪ Már nem ajánlott: ${r.itemName}`,
  description: `Az ajánlás ${previous} → ${r.recommendation}. ${r.summary}`,
  color: COLORS.neutral,
  footer: { text: `SKU: ${r.sku}` },
});

/**
 * Összeveti az új elemzést az utoljára látott ajánlásokkal, és Discord értesítést küld, ha egy
 * követett (és értesítésre jelölt) tárgy BUY-ra váltott, vagy már nem BUY. Sikertelen küldésnél
 * az állapot nem frissül, így a következő futás újrapróbálja. Visszaadja az elküldött üzenetek számát.
 */
export async function notifyRecommendationChanges(results: AnalysisEntry[], tracked: TrackedItem[]): Promise<number> {
  const state = await store.read<NotificationState>(FILE, {});
  const notifyFor = new Set(tracked.filter((i) => i.notify).map((i) => i.sku));
  let sent = 0;

  for (const result of results) {
    if (!('recommendation' in result)) continue;
    const previous = state[result.sku]?.recommendation;
    if (previous === result.recommendation) continue;

    const becameBuy = result.recommendation === 'BUY';
    const leftBuy = previous === 'BUY';
    if ((becameBuy || leftBuy) && notifyFor.has(result.sku) && discordService.isConfigured) {
      try {
        await discordService.send(becameBuy ? buyEmbed(result) : exitEmbed(result, previous!));
        sent++;
      } catch (error) {
        console.warn(`[notifier] ${result.sku} értesítése sikertelen: ${(error as Error).message}`);
        continue;
      }
    }
    state[result.sku] = { recommendation: result.recommendation, changedAt: new Date().toISOString() };
  }

  await store.write(FILE, state);
  return sent;
}

export function sendTestNotification() {
  return discordService.send({
    title: '🔔 Teszt értesítés',
    description: 'A TF2 Arbitrage Discord értesítései működnek. Itt fogsz üzenetet kapni, ha egy követett tárgy vételre ajánlott lesz.',
    color: COLORS.info,
  });
}

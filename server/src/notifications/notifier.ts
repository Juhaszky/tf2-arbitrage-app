import type { AnalysisEntry, AnalysisResult } from '../collector/collector.service';
import { config } from '../config';
import { FileStore } from '../storage/file.store';
import { COLORS, discordService } from './discord.service';

const FILE = 'notifications.json';

/** SKU-nként az utoljára látott ajánlás – csak a változásról szólunk. */
type NotificationState = Record<string, { recommendation: string; changedAt: string }>;

const store = new FileStore(config.dataDir);

type Money = { keys: number; metal: number } | null;

const formatPrice = (price: Money, keys: number) =>
  price ? `${price.keys} kulcs ${price.metal ? `+ ${price.metal} ref` : ''}`.trim() : `${keys} kulcs`;

/** A legjobb útvonal ajánlása (backpack.tf vagy mannco.store vétel). */
const recommendationOf = (r: AnalysisResult) => r.bestRoute.recommendation;

const buyEmbed = (r: AnalysisResult) => (r.bestRoute.source === 'mannco' && r.alternative ? manncoBuyEmbed(r, r.alternative) : {
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

const manncoBuyEmbed = (r: AnalysisResult, m: NonNullable<AnalysisResult['alternative']>) => ({
  title: `🟢 Vétel mannco.store-on: ${r.itemName}`,
  url: m.url ?? undefined,
  description: `Vedd meg a mannco.store-on, és add el backpack.tf-en. ${m.summary}`,
  color: COLORS.buy,
  fields: [
    { name: 'Vételi ár (mannco.store)', value: `${m.price.toFixed(2)} $ ≈ ${m.buyKeys} kulcs · ${m.stock} db`, inline: true },
    { name: 'Javasolt eladási ár (backpack.tf)', value: formatPrice(r.prices.targetSell, r.prices.targetSellKeys), inline: true },
    {
      name: 'Haszon',
      value: `óvatos: ${m.profit.conservativeProfitKeys} kulcs (${m.profit.conservativeMarginPercent}%) · várható: ${m.profit.expectedMarginPercent}%`,
      inline: false,
    },
    {
      name: 'Visszateszt',
      value: `${m.risk.backtestWinRatePercent}% nyerő (${m.risk.backtestIndependentTrades} független ügylet)`,
      inline: true,
    },
  ],
  footer: { text: `SKU: ${r.sku}` },
});

const exitEmbed = (r: AnalysisResult, previous: string) => ({
  title: `⚪ Már nem ajánlott: ${r.itemName}`,
  description: `Az ajánlás ${previous} → ${recommendationOf(r)}. ${r.bestRoute.source === 'mannco' && r.alternative ? r.alternative.summary : r.summary}`,
  color: COLORS.neutral,
  footer: { text: `SKU: ${r.sku}` },
});

/**
 * Összeveti az új elemzést az utoljára látott ajánlásokkal, és Discord értesítést küld, ha egy
 * tárgy, amelyre értesítést kérsz, BUY-ra váltott, vagy már nem BUY (bármelyik vételi útvonalon). Sikertelen küldésnél
 * az állapot nem frissül, így a következő futás újrapróbálja. Visszaadja az elküldött üzenetek számát.
 */
export async function notifyRecommendationChanges(
  results: AnalysisEntry[],
  shouldNotify: (sku: string) => Promise<boolean>,
  bptfUrlFor?: (sku: string, name: string) => string,
): Promise<number> {
  const state = await store.read<NotificationState>(FILE, {});
  let sent = 0;

  for (const result of results) {
    if (!('recommendation' in result)) continue;
    const recommendation = recommendationOf(result);
    const previous = state[result.sku]?.recommendation;
    if (previous === recommendation) continue;

    const becameBuy = recommendation === 'BUY';
    const leftBuy = previous === 'BUY';
    if ((becameBuy || leftBuy) && discordService.isConfigured && (await shouldNotify(result.sku))) {
      try {
        const embed = becameBuy ? buyEmbed(result) : exitEmbed(result, previous!);
        const links = [
          bptfUrlFor ? `[backpack.tf](${bptfUrlFor(result.sku, result.itemName)})` : null,
          result.alternative?.url ? `[mannco.store](${result.alternative.url})` : null,
        ].filter(Boolean).join(' · ');
        const fields = (embed as { fields?: { name: string; value: string; inline?: boolean }[] }).fields ?? [];
        await discordService.send(links ? { ...embed, fields: [...fields, { name: 'Linkek', value: links, inline: false }] } : embed);
        sent++;
      } catch (error) {
        console.warn(`[notifier] ${result.sku} értesítése sikertelen: ${(error as Error).message}`);
        continue;
      }
    }
    state[result.sku] = { recommendation, changedAt: new Date().toISOString() };
  }

  await store.write(FILE, state);
  return sent;
}

export function sendTestNotification() {
  return discordService.send({
    title: '🔔 Teszt értesítés',
    description: 'A TF2 Arbitrage Discord értesítései működnek. Itt fogsz üzenetet kapni, ha egy tárgy, amelyre értesítést kértél, vételre ajánlott lesz.',
    color: COLORS.info,
  });
}

import path from 'path';
import { AnalysisOptions } from './services/arbitrage.service';

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) ? value : fallback;
};

// JSON tömb (["722;11","40;11;kt-3"]) vagy vesszővel elválasztott lista (722;11,40;11;kt-3)
const skuList = (raw: string | undefined): string[] => {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  const list: unknown = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(',');
  if (!Array.isArray(list)) throw new Error('A TRACKED_SKUS JSON tömb vagy vesszővel elválasztott lista kell legyen.');
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
};

export const KEY_SKU = '5021;6';

export const config = {
  pricedbBaseUrl: process.env.PRICEDB_BASE_URL ?? 'https://pricedb.io/api',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() || undefined,

  collector: {
    enabled: process.env.COLLECTOR_ENABLED !== 'false',
    cron: process.env.COLLECT_CRON ?? '*/30 * * * *',
    runOnStartup: process.env.COLLECT_ON_STARTUP !== 'false',
    trackedSkus: skuList(process.env.TRACKED_SKUS),
    historyRefreshMinutes: num('HISTORY_REFRESH_MINUTES', 120),
    maxSkusPerRun: num('MAX_SKUS_PER_RUN', 20),
    requestDelayMs: num('REQUEST_DELAY_MS', 3000),
    itemsRefreshHours: num('ITEMS_REFRESH_HOURS', 24),
  },
};

/** Környezeti változókból jövő elemzési alapértékek (a kérés options mezője felülírja). */
export const envAnalysisOptions = (): Partial<AnalysisOptions> => {
  const result: Partial<AnalysisOptions> = {};
  const keyPrice = num('KEY_PRICE_METAL', 0);
  const fee = num('SELL_FEE_PERCENT', -1);
  if (keyPrice > 0) result.keyPriceMetal = keyPrice;
  if (fee >= 0) result.sellFeePercent = fee;
  return result;
};

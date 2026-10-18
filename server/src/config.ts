import path from 'path';
import { AnalysisOptions } from './services/arbitrage.service';

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) ? value : fallback;
};

export const KEY_SKU = '5021;6';

export const config = {
  pricedbBaseUrl: process.env.PRICEDB_BASE_URL ?? 'https://pricedb.io/api',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() || undefined,
  /** mannco.store API kulcs; nélküle a mannco ajánlatok kimaradnak az elemzésből. */
  manncoApiKey: process.env.MANNCO_API_KEY?.trim() || undefined,

  collector: {
    enabled: process.env.COLLECTOR_ENABLED !== 'false',
    cron: process.env.COLLECT_CRON ?? '*/30 * * * *',
    runOnStartup: process.env.COLLECT_ON_STARTUP !== 'false',
    historyRefreshMinutes: num('HISTORY_REFRESH_MINUTES', 120),
    maxSkusPerRun: num('MAX_SKUS_PER_RUN', 200),
    requestDelayMs: num('REQUEST_DELAY_MS', 1000),
    itemsRefreshHours: num('ITEMS_REFRESH_HOURS', 24),
  },

  mannco: {
    /** Futásonként legfeljebb ennyi tömeges árazó kérés a buy orderekhez (kérésenként 100 tárgy, percenként 10 mehet). */
    bidRequestsPerRun: num('MANNCO_BID_REQUESTS_PER_RUN', 30),
  },

  market: {
    /** Az előszűrés után vételi útvonalanként (backpack.tf, mannco.store) legfeljebb ennyi tárgy kap teljes (history alapú) elemzést. */
    maxCandidates: num('MAX_CANDIDATES', 150),
    /** Az előszűrés ennyi napi pillanatképen nézi, hogy az árrés tartós-e. */
    snapshotDays: num('SCREEN_SNAPSHOT_DAYS', 7),
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

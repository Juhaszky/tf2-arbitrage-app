import cron from 'node-cron';
import { config } from '../config';
import { collectorService } from './collector.service';

export async function startCollector() {
  const { enabled, cron: expression, runOnStartup } = config.collector;

  if (!enabled) {
    console.log('[collector] Kikapcsolva (COLLECTOR_ENABLED=false).');
    return;
  }
  if (!cron.validate(expression)) {
    console.error(`[collector] Érvénytelen COLLECT_CRON kifejezés: "${expression}". A gyűjtő nem indul el.`);
    return;
  }

  cron.schedule(expression, () => collectorService.run('ütemezett'), { name: 'pricedb-collector', noOverlap: true });
  console.log(`[collector] Ütemezve: "${expression}", futásonként a teljes piac előszűrése.`);

  if (runOnStartup) void collectorService.run('indulás');
}

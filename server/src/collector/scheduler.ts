import cron from 'node-cron';
import { config } from '../config';
import { trackingService } from '../tracking/tracking.service';
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

  const tracked = await trackingService.list();
  if (tracked.length === 0) {
    console.warn('[collector] Nincs követett tárgy – a frontenden vehetsz fel újat. Addig csak a kulcsár frissül.');
  }

  cron.schedule(expression, () => collectorService.run('ütemezett'), { name: 'pricedb-collector', noOverlap: true });
  console.log(`[collector] Ütemezve: "${expression}", ${tracked.length} követett tárgy.`);

  if (runOnStartup) void collectorService.run('indulás');
}

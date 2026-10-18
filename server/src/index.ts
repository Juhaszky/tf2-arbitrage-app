import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import arbitrageRoutes from './routes/arbitrage.routes';
import collectorRoutes from './routes/collector.routes';
import itemsRoutes from './routes/items.routes';
import notificationsRoutes from './routes/notifications.routes';
import trackedRoutes from './routes/tracked.routes';
import { startCollector } from './collector/scheduler';

const app = express();
// Egy éves history is beleférjen
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// Útvonalak bekötése
app.use('/api/arbitrage', arbitrageRoutes);
app.use('/api/collector', collectorRoutes);
app.use('/api/tracked', trackedRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/notifications', notificationsRoutes);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`🚀 Szerver fut a ${port}-es porton`);
  startCollector().catch((error) => console.error('[collector] Nem sikerült elindítani:', error));
});

import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';

// GET /api/collector/status
export const getCollectorStatus = async (_req: Request, res: Response) => {
  try {
    return res.json(await collectorService.getStatus());
  } catch (error) {
    console.error('Státusz hiba:', error);
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};

// POST /api/collector/run – azonnali gyűjtés a háttérben (csak az esedékes SKU-kra)
export const runCollector = (_req: Request, res: Response) => {
  if (collectorService.isRunning) {
    return res.status(409).json({ error: 'Már fut egy gyűjtés.' });
  }
  void collectorService.run('kézi');
  return res.status(202).json({ message: 'A gyűjtés elindult. Az állapot: GET /api/collector/status' });
};

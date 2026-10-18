import { Router } from 'express';
import { getCollectorStatus, runCollector } from '../controllers/collector.controller';

const router = Router();

// GET /api/collector/status
router.get('/status', getCollectorStatus);

// POST /api/collector/run
router.post('/run', runCollector);

export default router;

import { Router } from 'express';
import { analyzeArbitrage, getTrackedAnalysis, getTrackedSku } from '../controllers/arbitrage.controller';

const router = Router();

// POST /api/arbitrage/analyze
router.post('/analyze', analyzeArbitrage);

// GET /api/arbitrage/tracked?recommendation=BUY
router.get('/tracked', getTrackedAnalysis);

// GET /api/arbitrage/tracked/:sku
router.get('/tracked/:sku', getTrackedSku);

export default router;

import { Router } from 'express';
import { getMarket, updateFilter } from '../controllers/market.controller';

const router = Router();

// GET /api/market
router.get('/', getMarket);

// PUT /api/market/filter
router.put('/filter', updateFilter);

export default router;

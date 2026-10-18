import { Router } from 'express';
import { getItemStats, searchItems } from '../controllers/items.controller';

const router = Router();

// GET /api/items/search?q=...
router.get('/search', searchItems);

// GET /api/items/:sku/stats
router.get('/:sku/stats', getItemStats);

export default router;

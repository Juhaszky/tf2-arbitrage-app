import { Router } from 'express';
import { getDeals } from '../controllers/deals.controller';

const router = Router();

// GET /api/deals
router.get('/', getDeals);

export default router;

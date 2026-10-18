import { Router } from 'express';
import { searchItems } from '../controllers/tracked.controller';

const router = Router();

// GET /api/items/search?q=...
router.get('/search', searchItems);

export default router;

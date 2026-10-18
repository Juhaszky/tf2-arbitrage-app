import { Router } from 'express';
import { addTracked, listTracked, removeTracked, updateTracked } from '../controllers/tracked.controller';

const router = Router();

// GET /api/tracked
router.get('/', listTracked);

// POST /api/tracked
router.post('/', addTracked);

// PATCH /api/tracked/:sku
router.patch('/:sku', updateTracked);

// DELETE /api/tracked/:sku
router.delete('/:sku', removeTracked);

export default router;

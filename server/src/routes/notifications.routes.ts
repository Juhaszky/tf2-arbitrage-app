import { Router } from 'express';
import { getNotificationStatus, testNotification } from '../controllers/notifications.controller';

const router = Router();

// GET /api/notifications/status
router.get('/status', getNotificationStatus);

// POST /api/notifications/test
router.post('/test', testNotification);

export default router;

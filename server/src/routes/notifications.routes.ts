import { Router } from 'express';
import {
  getNotificationStatus,
  testNotification,
  updateItemNotification,
  updateNotificationSettings,
} from '../controllers/notifications.controller';

const router = Router();

// GET /api/notifications/status
router.get('/status', getNotificationStatus);

// PUT /api/notifications/settings
router.put('/settings', updateNotificationSettings);

// PUT /api/notifications/items/:sku
router.put('/items/:sku', updateItemNotification);

// POST /api/notifications/test
router.post('/test', testNotification);

export default router;

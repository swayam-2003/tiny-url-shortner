import { Router } from 'express';
import {
  shortenUrl,
  getUrlMetadata,
  getAnalytics,
  deactivateUrl,
} from '../controllers/urlController.js';
import { shortenRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.post('/urls', shortenRateLimiter, shortenUrl);
router.get('/urls/:shortCode', getUrlMetadata);
router.get('/urls/:shortCode/analytics', getAnalytics);
router.delete('/urls/:shortCode', deactivateUrl);

export default router;

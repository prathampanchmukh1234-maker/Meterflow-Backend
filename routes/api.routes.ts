import { Router } from 'express';
import * as apiController from '../controllers/api.controller';
import * as keyController from '../controllers/key.controller';
import * as analyticsController from '../controllers/analytics.controller';
import * as billingController from '../controllers/billing.controller';
import * as webhookController from '../controllers/webhook.controller';
import * as paymentController from '../controllers/payment.controller';
import * as userController from '../controllers/user.controller';
import * as notificationController from '../controllers/notification.controller';
import { verifyAuth, requireRole } from '../middleware/auth';
import { validateApiKey, rateLimit, proxyRequest } from '../middleware/gateway';

const router = Router();

// Gateway Route (The core feature)
// Mount this at /gateway/*
router.all('/gateway/*', validateApiKey, rateLimit, proxyRequest);

router.get('/me', verifyAuth, userController.getProfile);
router.get('/plans', verifyAuth, billingController.getPlans);
router.get('/notifications', verifyAuth, notificationController.getNotifications);

// Management Routes
router.get('/apis', verifyAuth, requireRole('api_owner', 'admin'), apiController.getApis);
router.post('/apis', verifyAuth, requireRole('api_owner', 'admin'), apiController.createApi);
router.put('/apis/:id', verifyAuth, requireRole('api_owner', 'admin'), apiController.updateApi);
router.delete('/apis/:id', verifyAuth, requireRole('api_owner', 'admin'), apiController.deleteApi);

router.get('/keys', verifyAuth, requireRole('api_owner', 'admin'), keyController.getApiKeys);
router.post('/keys', verifyAuth, requireRole('api_owner', 'admin'), keyController.createApiKey);
router.post('/keys/:id/revoke', verifyAuth, requireRole('api_owner', 'admin'), keyController.revokeApiKey);
router.post('/keys/:id/rotate', verifyAuth, requireRole('api_owner', 'admin'), keyController.rotateApiKey);

router.get('/analytics/usage', verifyAuth, requireRole('api_owner', 'admin'), analyticsController.getUsageStats);
router.get('/analytics/endpoints', verifyAuth, requireRole('api_owner', 'admin'), analyticsController.getTopEndpoints);
router.get('/analytics/logs', verifyAuth, requireRole('api_owner', 'admin'), analyticsController.getRequestLogs);

router.get('/billing', verifyAuth, requireRole('api_owner', 'admin'), billingController.getBillingHistory);
router.get('/billing/current', verifyAuth, requireRole('api_owner', 'admin'), billingController.getCurrentUsage);
router.post('/billing/generate-current', verifyAuth, requireRole('api_owner', 'admin'), billingController.generateCurrentInvoice);
router.post('/billing/change-plan', verifyAuth, requireRole('api_owner', 'admin'), billingController.changePlan);

// Admin-only routes
import { getAllBillingHistory } from '../controllers/billing.controller';
router.get('/admin/billing-all', verifyAuth, requireRole('admin'), getAllBillingHistory);

router.get('/webhooks', verifyAuth, webhookController.getWebhooks);
router.post('/webhooks', verifyAuth, webhookController.createWebhook);
router.delete('/webhooks/:id', verifyAuth, webhookController.deleteWebhook);
router.post('/webhooks/:id/test', verifyAuth, webhookController.testWebhook);

router.post('/payments/create-order', verifyAuth, paymentController.createOrder);
router.post('/payments/verify', verifyAuth, paymentController.verifyPayment);
router.post('/payments/create-plan-order', verifyAuth, requireRole('api_owner', 'admin'), paymentController.createPlanOrder);
router.post('/payments/verify-plan', verifyAuth, requireRole('api_owner', 'admin'), paymentController.verifyPlanPayment);

export default router;

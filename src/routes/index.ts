import { Router, type Request, type Response } from 'express';
import healthRoutes from './health.routes';
import researchRoutes from './research.routes';

export const router: Router = Router();

// Mount health routes (no auth required, handled in app.ts)
router.use('/health', healthRoutes);

// Mount research routes (with auth and rate limiting)
router.use('/research', researchRoutes);

// API info endpoint
router.get('/', (_req, res) => {
  res.json({
    name: 'Agentic Research Assistant API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      research: '/research',
    },
  });
});

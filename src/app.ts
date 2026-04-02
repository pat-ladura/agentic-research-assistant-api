import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { requestLogger } from './middleware/request-logger';
import { generalLimiter, aiLimiter } from './middleware/rate-limiter';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { router } from './routes';
import { logger } from './lib/logger';

export function createApp(): Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors());

  // Body parser middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use(requestLogger);

  // Apply general rate limiter globally
  app.use(generalLimiter);

  // Health check route (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Protect API routes with auth and stricter rate limiting
  app.use('/api/', authMiddleware);
  app.use('/api/research', aiLimiter);

  // Application routes
  app.use('/api', router);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        status: 404,
        message: 'Not Found',
      },
    });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

export async function startServer(app: Application, port: number) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`⚡ Server listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}

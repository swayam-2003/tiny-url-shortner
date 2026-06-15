import './config/env.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './config/logger.js';
import { runMigrations } from './scripts/migrate.js';
import { checkRedisHealth } from './config/redis.js';
import v1Routes from './routes/v1Routes.js';
import { healthController } from './controllers/healthController.js';
import { redirectHandler } from './controllers/redirectController.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { securityMiddleware } from './middleware/security.js';
import { apiRateLimiter, redirectRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(requestIdMiddleware);
app.use(securityMiddleware);
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: process.env.NODE_ENV === 'production',
}));
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.BASE_URL : true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
}));
app.use(express.json({ limit: '16kb' }));
app.use(pinoHttp({ logger, customProps: (req) => ({ requestId: req.requestId }) }));

app.get('/health', healthController);
app.use('/api/v1', apiRateLimiter, v1Routes);
app.get('/:shortCode', redirectRateLimiter, redirectHandler);
app.use(notFoundHandler);
app.use(errorHandler);

async function start(): Promise<void> {
  await runMigrations();
  await checkRedisHealth();
  app.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}`);
    logger.info(`Base URL: ${process.env.BASE_URL ?? `http://localhost:${port}`}`);
  });
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

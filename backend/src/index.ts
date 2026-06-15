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
import { apiRateLimiter, redirectRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.BASE_URL : true }));
app.use(express.json({ limit: '16kb' }));
app.use(pinoHttp({ logger }));

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

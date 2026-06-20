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
import { serverIdMiddleware } from './middleware/serverId.js';
import { securityMiddleware } from './middleware/security.js';
import { apiRateLimiter, redirectRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { corsOptions } from './config/cors.js';
import { registerStaticAssets } from './config/staticAssets.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(requestIdMiddleware);
app.use(serverIdMiddleware);
app.use(securityMiddleware);
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: process.env.NODE_ENV === 'production',
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '16kb' }));
app.use(pinoHttp({ logger, customProps: (req) => ({ requestId: req.requestId }) }));

app.get('/health', healthController);
app.use('/api/v1', apiRateLimiter, v1Routes);
registerStaticAssets(app);
app.get('/:shortCode([a-zA-Z0-9_-]{3,12})', redirectRateLimiter, redirectHandler);
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

import type { ClickEvent } from '../types/index.js';
import { analyticsRepository, urlRepository } from '../repositories/urlRepository.js';
import { logger } from '../config/logger.js';

class AnalyticsQueue {
  private queue: ClickEvent[] = [];
  private processing = false;
  private readonly batchSize = 10;
  private readonly flushIntervalMs = 1000;

  constructor() {
    setInterval(() => this.flush(), this.flushIntervalMs);
  }

  enqueue(event: ClickEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);

    try {
      await Promise.all(
        batch.map(async (event) => {
          await analyticsRepository.recordClick(
            event.urlId,
            event.ipHash,
            event.userAgent,
            event.referer
          );
          await urlRepository.incrementClickCount(event.urlId);
        })
      );
      logger.debug({ count: batch.length }, 'Analytics batch processed');
    } catch (err) {
      logger.error({ err }, 'Analytics batch failed, re-queuing');
      this.queue.unshift(...batch);
    } finally {
      this.processing = false;
    }
  }
}

export const analyticsQueue = new AnalyticsQueue();

export function enqueueClick(event: ClickEvent): void {
  analyticsQueue.enqueue(event);
}

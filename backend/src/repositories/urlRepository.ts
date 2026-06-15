import { pool } from '../config/database.js';
import { COUNTER_KEY, redis } from '../config/redis.js';
import type { UrlRecord } from '../types/index.js';

export class CounterRepository {
  async nextId(): Promise<number> {
    try {
      if (redis.status !== 'ready') {
        await redis.connect();
      }
      const id = await redis.incr(COUNTER_KEY);
      return id;
    } catch {
      const result = await pool.query<{ nextval: string }>(
        "SELECT nextval(pg_get_serial_sequence('urls', 'id')) AS nextval"
      );
      return parseInt(result.rows[0].nextval, 10);
    }
  }
}

export class UrlRepository {
  async findByShortCode(shortCode: string): Promise<UrlRecord | null> {
    const result = await pool.query<UrlRecord>(
      `SELECT id, short_code, long_url, created_at, expires_at, is_active, click_count
       FROM urls WHERE short_code = $1`,
      [shortCode]
    );
    return result.rows[0] ?? null;
  }

  async findByLongUrl(longUrl: string): Promise<UrlRecord | null> {
    const result = await pool.query<UrlRecord>(
      `SELECT id, short_code, long_url, created_at, expires_at, is_active, click_count
       FROM urls WHERE long_url = $1 AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [longUrl]
    );
    return result.rows[0] ?? null;
  }

  async create(
    shortCode: string,
    longUrl: string,
    expiresAt: Date | null
  ): Promise<UrlRecord> {
    const result = await pool.query<UrlRecord>(
      `INSERT INTO urls (short_code, long_url, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, short_code, long_url, created_at, expires_at, is_active, click_count`,
      [shortCode, longUrl, expiresAt]
    );
    return result.rows[0];
  }

  async deactivate(shortCode: string): Promise<UrlRecord | null> {
    const result = await pool.query<UrlRecord>(
      `UPDATE urls SET is_active = FALSE
       WHERE short_code = $1 AND is_active = TRUE
       RETURNING id, short_code, long_url, created_at, expires_at, is_active, click_count`,
      [shortCode]
    );
    return result.rows[0] ?? null;
  }

  async incrementClickCount(urlId: number): Promise<void> {
    await pool.query('UPDATE urls SET click_count = click_count + 1 WHERE id = $1', [urlId]);
  }
}

export class AnalyticsRepository {
  async recordClick(
    urlId: number,
    ipHash: string | null,
    userAgent: string | null,
    referer: string | null
  ): Promise<void> {
    await pool.query(
      `INSERT INTO url_clicks (url_id, ip_hash, user_agent, referer) VALUES ($1, $2, $3, $4)`,
      [urlId, ipHash, userAgent, referer]
    );
  }

  async getClicksLast7Days(urlId: number): Promise<{ date: string; count: number }[]> {
    const result = await pool.query<{ date: string; count: string }>(
      `SELECT to_char(clicked_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM url_clicks
       WHERE url_id = $1 AND clicked_at >= NOW() - INTERVAL '7 days'
       GROUP BY to_char(clicked_at, 'YYYY-MM-DD')
       ORDER BY date ASC`,
      [urlId]
    );

    const clickMap = new Map(result.rows.map((r) => [r.date, Number(r.count)]));
    const days: { date: string; count: number }[] = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      days.push({ date: dateStr, count: clickMap.get(dateStr) ?? 0 });
    }

    return days;
  }

  async getRecentClicks(
    urlId: number,
    limit = 10
  ): Promise<{ clicked_at: Date; referer: string | null; user_agent: string | null }[]> {
    const result = await pool.query<{
      clicked_at: Date;
      referer: string | null;
      user_agent: string | null;
    }>(
      `SELECT clicked_at, referer, user_agent
       FROM url_clicks WHERE url_id = $1
       ORDER BY clicked_at DESC LIMIT $2`,
      [urlId, limit]
    );
    return result.rows;
  }
}

export const counterRepository = new CounterRepository();
export const urlRepository = new UrlRepository();
export const analyticsRepository = new AnalyticsRepository();

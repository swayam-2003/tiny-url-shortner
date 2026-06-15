import type { AnalyticsSummary, CreateUrlInput, ShortenResult, UrlMetadata } from '../types/index.js';
import { AppError } from '../types/index.js';
import { counterRepository, urlRepository, analyticsRepository } from '../repositories/urlRepository.js';
import { cacheRepository } from '../repositories/cacheRepository.js';
import { generateShortCode, MAX_RETRIES } from '../utils/shortCode.js';
import { validateCustomAlias, validateLongUrl } from '../utils/urlValidator.js';

const baseUrl = () => process.env.BASE_URL ?? 'http://localhost:3001';
const defaultExpiryDays = () => Number(process.env.DEFAULT_EXPIRY_DAYS ?? 1825);

function buildShortUrl(shortCode: string): string {
  return `${baseUrl()}/${shortCode}`;
}

function computeExpiresAt(days?: number): Date | null {
  const expiryDays = days ?? defaultExpiryDays();
  if (expiryDays <= 0) return null;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);
  return expiresAt;
}

function toMetadata(record: NonNullable<Awaited<ReturnType<typeof urlRepository.findByShortCode>>>): UrlMetadata {
  return {
    shortCode: record.short_code,
    shortUrl: buildShortUrl(record.short_code),
    longUrl: record.long_url,
    createdAt: record.created_at.toISOString(),
    expiresAt: record.expires_at?.toISOString() ?? null,
    isActive: record.is_active,
    clickCount: Number(record.click_count),
  };
}

function assertUrlActive(record: NonNullable<Awaited<ReturnType<typeof urlRepository.findByShortCode>>>): void {
  if (!record.is_active) throw new AppError(410, 'LINK_INACTIVE', 'This short link has been deactivated');
  if (record.expires_at && record.expires_at < new Date()) {
    throw new AppError(410, 'LINK_EXPIRED', 'This short link has expired');
  }
}

function toShortenResult(record: NonNullable<Awaited<ReturnType<typeof urlRepository.create>>>): ShortenResult {
  return {
    shortCode: record.short_code,
    shortUrl: buildShortUrl(record.short_code),
    longUrl: record.long_url,
    expiresAt: record.expires_at?.toISOString() ?? null,
    createdAt: record.created_at.toISOString(),
  };
}

export const urlService = {
  async shorten(input: CreateUrlInput): Promise<ShortenResult> {
    const longUrl = validateLongUrl(input.longUrl);
    const expiresAt = computeExpiresAt(input.expiresInDays);

    if (input.customAlias) {
      const alias = validateCustomAlias(input.customAlias);
      if (await urlRepository.findByShortCode(alias)) {
        throw new AppError(409, 'ALIAS_TAKEN', 'Custom alias is already in use');
      }
      const record = await urlRepository.create(alias, longUrl, expiresAt);
      await cacheRepository.set(record.short_code, record.long_url);
      return toShortenResult(record);
    }

    const existing = await urlRepository.findByLongUrl(longUrl);
    if (existing) {
      assertUrlActive(existing);
      return toShortenResult(existing);
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const shortCode = generateShortCode(await counterRepository.nextId());
      try {
        const record = await urlRepository.create(shortCode, longUrl, expiresAt);
        await cacheRepository.set(record.short_code, record.long_url);
        return toShortenResult(record);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
    }

    throw new AppError(500, 'CODE_GENERATION_FAILED', 'Failed to generate unique short code');
  },

  async getMetadata(shortCode: string): Promise<UrlMetadata> {
    const record = await urlRepository.findByShortCode(shortCode);
    if (!record) throw new AppError(404, 'NOT_FOUND', 'URL not found');
    return toMetadata(record);
  },

  async deactivate(shortCode: string): Promise<UrlMetadata> {
    const record = await urlRepository.deactivate(shortCode);
    if (!record) throw new AppError(404, 'NOT_FOUND', 'URL not found or already inactive');
    await cacheRepository.invalidate(shortCode);
    return toMetadata(record);
  },

  async getAnalytics(shortCode: string): Promise<AnalyticsSummary> {
    const record = await urlRepository.findByShortCode(shortCode);
    if (!record) throw new AppError(404, 'NOT_FOUND', 'URL not found');

    const [clicksLast7Days, recentClicks] = await Promise.all([
      analyticsRepository.getClicksLast7Days(record.id),
      analyticsRepository.getRecentClicks(record.id),
    ]);

    return {
      shortCode: record.short_code,
      longUrl: record.long_url,
      totalClicks: Number(record.click_count),
      clicksLast7Days,
      recentClicks: recentClicks.map((c) => ({
        clickedAt: c.clicked_at.toISOString(),
        referer: c.referer,
        userAgent: c.user_agent,
      })),
    };
  },
};

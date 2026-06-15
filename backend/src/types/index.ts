export interface UrlRecord {
  id: number;
  short_code: string;
  long_url: string;
  created_at: Date;
  expires_at: Date | null;
  is_active: boolean;
  click_count: number;
}

export interface UrlClickRecord {
  id: number;
  url_id: number;
  clicked_at: Date;
  ip_hash: string | null;
  user_agent: string | null;
  referer: string | null;
}

export interface CreateUrlInput {
  longUrl: string;
  customAlias?: string;
  expiresInDays?: number;
}

export interface ShortenResult {
  shortCode: string;
  shortUrl: string;
  longUrl: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface UrlMetadata {
  shortCode: string;
  shortUrl: string;
  longUrl: string;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
  clickCount: number;
}

export interface ClickEvent {
  urlId: number;
  shortCode: string;
  ipHash: string | null;
  userAgent: string | null;
  referer: string | null;
}

export interface AnalyticsSummary {
  shortCode: string;
  longUrl: string;
  totalClicks: number;
  clicksLast7Days: { date: string; count: number }[];
  recentClicks: {
    clickedAt: string;
    referer: string | null;
    userAgent: string | null;
  }[];
}

export interface ApiError {
  error: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

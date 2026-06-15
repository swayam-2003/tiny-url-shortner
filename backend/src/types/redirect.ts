export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export interface RedirectResult {
  longUrl: string;
  cacheStatus: CacheStatus;
  latencyMs: number;
}

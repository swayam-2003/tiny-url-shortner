import { base62Encode, randomBase62 } from './base62.js';

const MAX_RETRIES = 3;

export function generateShortCode(counterId: number): string {
  const base = base62Encode(counterId);
  const suffix = randomBase62(2);
  return base + suffix;
}

export function generateCustomCode(alias: string): string {
  return alias.trim();
}

export { MAX_RETRIES };

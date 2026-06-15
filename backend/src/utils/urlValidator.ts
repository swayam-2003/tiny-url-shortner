import { AppError } from '../types/index.js';
import { isPrivateOrLocalUrl } from '../middleware/security.js';

const URL_REGEX =
  /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)$/;

const BLOCKED_PROTOCOLS = /^(javascript|data|file|ftp):/i;
const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,12}$/;

export function validateLongUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new AppError(400, 'INVALID_URL', 'URL is required');
  if (BLOCKED_PROTOCOLS.test(trimmed)) {
    throw new AppError(400, 'INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
  }
  if (!URL_REGEX.test(trimmed)) {
    throw new AppError(400, 'INVALID_URL', 'Please provide a valid HTTP or HTTPS URL');
  }
  if (trimmed.length > 2048) {
    throw new AppError(400, 'URL_TOO_LONG', 'URL must be 2048 characters or fewer');
  }
  if (isPrivateOrLocalUrl(trimmed)) {
    throw new AppError(400, 'SSRF_BLOCKED', 'URLs pointing to private or local networks are not allowed');
  }
  return trimmed;
}

export function validateCustomAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!ALIAS_REGEX.test(trimmed)) {
    throw new AppError(
      400,
      'INVALID_ALIAS',
      'Custom alias must be 3-12 characters (letters, numbers, hyphens, underscores)'
    );
  }
  const reserved = new Set(['api', 'health', 'admin', 'login', 'www']);
  if (reserved.has(trimmed.toLowerCase())) {
    throw new AppError(400, 'INVALID_ALIAS', 'This alias is reserved');
  }
  return trimmed;
}

export function validateShortCode(code: string): string {
  const trimmed = code.trim();
  if (!/^[a-zA-Z0-9_-]{3,12}$/.test(trimmed)) {
    throw new AppError(400, 'INVALID_SHORT_CODE', 'Invalid short code format');
  }
  return trimmed;
}

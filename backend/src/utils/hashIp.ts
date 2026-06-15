import { createHash } from 'crypto';

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

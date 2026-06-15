const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function base62Encode(num: number): string {
  if (num === 0) return BASE62_CHARS[0];
  let result = '';
  let n = num;
  while (n > 0) {
    result = BASE62_CHARS[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

export function randomBase62(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE62_CHARS[b % 62]).join('');
}

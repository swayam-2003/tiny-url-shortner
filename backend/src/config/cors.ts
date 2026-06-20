function parseAllowedOrigins(): string | string[] | boolean {
  if (process.env.NODE_ENV !== 'production') return true;

  const raw = process.env.ALLOWED_ORIGINS ?? process.env.BASE_URL;
  if (!raw) return false;

  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  return origins.length === 1 ? origins[0] : origins;
}

export const corsOptions = {
  origin: parseAllowedOrigins(),
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
};

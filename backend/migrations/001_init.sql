-- urls: source of truth
CREATE TABLE IF NOT EXISTS urls (
  id            BIGSERIAL PRIMARY KEY,
  short_code    VARCHAR(12) NOT NULL UNIQUE,
  long_url      TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT TRUE,
  click_count   BIGINT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
CREATE INDEX IF NOT EXISTS idx_urls_expires_at ON urls(expires_at) WHERE is_active = TRUE;

-- url_clicks: async analytics store
CREATE TABLE IF NOT EXISTS url_clicks (
  id          BIGSERIAL PRIMARY KEY,
  url_id      BIGINT REFERENCES urls(id) ON DELETE CASCADE,
  clicked_at  TIMESTAMPTZ DEFAULT NOW(),
  ip_hash     VARCHAR(64),
  user_agent  TEXT,
  referer     TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_url_id ON url_clicks(url_id, clicked_at DESC);

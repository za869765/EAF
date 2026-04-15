-- Cloudflare D1 初始化 schema
-- 執行方式：wrangler d1 execute eaf-records --file=schema.sql

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  voucher_no TEXT,
  form_type  TEXT,
  voided     INTEGER DEFAULT 0,
  saved_at   TEXT,
  data       TEXT NOT NULL        -- 完整 JSON blob
);

CREATE INDEX IF NOT EXISTS idx_saved_at  ON records(saved_at);
CREATE INDEX IF NOT EXISTS idx_form_type ON records(form_type);
CREATE INDEX IF NOT EXISTS idx_voided    ON records(voided);

-- v4.2.28 憑證編號唯一性（DB 層最後一道關）
-- 允許空字串 / NULL（未取號的草稿），但非空值必須唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_no_unique
  ON records(voucher_no)
  WHERE voucher_no IS NOT NULL AND voucher_no != '';

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL             -- JSON blob（科目設定等）
);

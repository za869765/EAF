-- ACC v2 結構化資料表（取代 settings 表的 acc_* key/value）
-- 執行：wrangler d1 execute eaf-records --file=migrations/0002_acc_v2.sql
-- 或：Cloudflare Dashboard → D1 → eaf-records → Console 貼上執行
-- 注意：這是 ADDITIVE migration。不動 records / settings / payees 表，EAF 動支單零影響。

-- ─── 月度轉帳傳票（每 ym 一列，entries 為分錄陣列 JSON） ───
CREATE TABLE IF NOT EXISTS acc_vouchers (
  ym         TEXT PRIMARY KEY,
  entries    TEXT NOT NULL DEFAULT '[]',
  locked     INTEGER NOT NULL DEFAULT 0,
  locked_at  TEXT,
  updated_at TEXT NOT NULL
);

-- ─── 月底結算資料（月結卡片/收入分類/出納等，每 ym 一列） ───
CREATE TABLE IF NOT EXISTS acc_monthly (
  ym         TEXT PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '{}',
  locked     INTEGER NOT NULL DEFAULT 0,
  locked_at  TEXT,
  updated_at TEXT NOT NULL
);

-- ─── 明細帳（藥品 / 衛材 / 備抵 / 財產） ───
CREATE TABLE IF NOT EXISTS acc_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_type TEXT NOT NULL,
  ym          TEXT NOT NULL,
  entry_type  TEXT NOT NULL,
  amount      INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  ref_id      TEXT,
  voided      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_ledger_type_ym ON acc_ledger(ledger_type, ym);
CREATE INDEX IF NOT EXISTS idx_acc_ledger_type    ON acc_ledger(ledger_type);

-- ─── 設定值（期初餘額、折舊月額、出納附記等） ───
CREATE TABLE IF NOT EXISTS acc_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

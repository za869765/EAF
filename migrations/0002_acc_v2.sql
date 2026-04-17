-- ACC v2 結構化資料表（取代 settings 表的 acc_* key/value）
-- 執行：wrangler d1 execute eaf-records --file=migrations/0002_acc_v2.sql
-- 或：Cloudflare Dashboard → D1 → eaf-records → Console 貼上執行
-- 注意：這是 ADDITIVE migration。不動 records / settings / payees 表，EAF 動支單零影響。

-- ─── 月度轉帳傳票（向後相容：ACC 月底結算 grouped entries） ───
CREATE TABLE IF NOT EXISTS acc_vouchers (
  ym         TEXT PRIMARY KEY,
  entries    TEXT NOT NULL DEFAULT '[]',
  locked     INTEGER NOT NULL DEFAULT 0,
  locked_at  TEXT,
  updated_at TEXT NOT NULL
);

-- ─── 分錄顆粒表（收入/支出/轉帳 所有傳票分錄，Excel 匯入用） ───
-- 唯一鍵 (voucher_no, seq) 保證重複匯入同張傳票會 upsert
CREATE TABLE IF NOT EXISTS acc_voucher_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no    TEXT NOT NULL,                   -- '115100001'
  voucher_type  TEXT NOT NULL,                   -- 收入/支出/轉帳
  ym            TEXT NOT NULL,                   -- '11501'
  seq           INTEGER NOT NULL,                -- 分錄序號（1-based）
  make_date     TEXT,                            -- 製票日期 115/01/07
  post_date     TEXT,                            -- 入帳日期
  subject       TEXT,                            -- 11010202 保管款專戶
  sub_account   TEXT,                            -- 沖銷科目子目
  purpose       TEXT,                            -- 用途別
  description   TEXT,                            -- 摘要
  debit         INTEGER NOT NULL DEFAULT 0,
  credit        INTEGER NOT NULL DEFAULT 0,
  payee_info    TEXT,
  payee_amount  INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'excel_import',   -- excel_import / month_end_gen / manual
  imported_at   TEXT,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_ventry_key  ON acc_voucher_entries(voucher_no, seq);
CREATE INDEX        IF NOT EXISTS idx_acc_ventry_ym   ON acc_voucher_entries(ym);
CREATE INDEX        IF NOT EXISTS idx_acc_ventry_type ON acc_voucher_entries(voucher_type);

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

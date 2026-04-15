-- v4.2.28 憑證編號唯一性 — 套用到既有 prod D1
-- 執行：wrangler d1 execute eaf-records --remote --file=migrations/0001_voucher_unique.sql
--
-- 前置檢查（先手動跑這兩行確認現有資料是否已無重複）：
--   SELECT voucher_no, COUNT(*) c FROM records
--     WHERE voucher_no IS NOT NULL AND voucher_no != ''
--     GROUP BY voucher_no HAVING c > 1;
-- 若上面有結果，請先人工修正重複後再建索引。

CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_no_unique
  ON records(voucher_no)
  WHERE voucher_no IS NOT NULL AND voucher_no != '';

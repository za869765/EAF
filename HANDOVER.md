# 專案接力記錄 — 2026/04/05

> 明天說「繼續」時：先 `git pull` 拉取此檔，讀完後主動說明各項進度，再問從哪個開始。

---

## 📌 各專案目前狀態

### 1. EAF 動支管理系統 + ACC 會計帳務
**路徑:** `C:/Users/USER/Desktop/CODE/project/EAF`
**GitHub:** `za869765/EAF`
**版本:** `v4.0.1`（acc.html / admin.html / index.html 三檔同步）
**部署:** Cloudflare Pages 自動部署

#### ✅ 04/05 完成（v3.9.4 → v4.0.1）
| 版本 | 內容 |
|------|------|
| v3.9.5 | 首頁移除年度收支累積區塊 |
| v3.9.6 | 產製傳票同步更新 fund5 至 acc_yeardata |
| v3.9.7 | 修正1月fund5 277＋正名醫療作業基金提撥 |
| v3.9.8 | 修正3月fund5 3740 |
| v3.9.9 | 強制覆蓋Q1 fund5種子值＋flag 302 |
| v4.0.0 | 支出傳票上傳沖銷（應付費用/代收款/累積賸餘） |
| v4.0.1 | 互動式預覽＋99其他獨立分類＋02a/02b智慧拆分 |

#### ⏳ 待辦
- [ ] 支出傳票沖銷實際測試（4月底5月初）
- [ ] 防重複上傳機制
- [ ] 衛生保健拆分完整測試（預計5月有資料）
- [ ] 收入掛帳分類細拆（藥品/門診/預防保健）
- [ ] 4月轉帳傳票產製測試

#### 重要設計規則
- 每次修改三檔版次同步
- 版次進位：子版號到9就進位（v3.9.9→v4.0.0）
- 每次改動必須 commit + push
- 獎勵金計算表公式文件：`docs/115獎勵金計算表_公式說明.md`

---

### 2. GIS 佳里區 GIS 查詢系統
**版本:** v6.436 | **狀態:** 穩定運作中

### 3. CLASS 系統
**狀態:** 🆕 尚未開始

---

## 🚀 接力步驟

1. 讀取本檔 `C:/Users/USER/Desktop/CODE/project/EAF/HANDOVER.md`
2. `git -C C:/Users/USER/Desktop/CODE/project/EAF pull`
3. `git -C C:/Users/USER/Desktop/CODE/project/EAF log --oneline -10`
4. 向使用者報告進度，問從哪個開始

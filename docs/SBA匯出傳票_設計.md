# SBA 匯入傳票產製功能 — 設計文件 v1

> 目標：在 EAF（佳里區衛生所 醫療作業基金）新增 `sba.html`「傳票工坊」頁——
> 勾選近期有效的動支單/請購單 → 批次產生**支出傳票**（保管款/基金款分開開票）→
> 下載 SBA 作業型「匯入傳票資料檔」ZIP（F03/F04/F05/F06/F07 XML），直接於 SBA『匯入傳票』作業匯入。
> 另附**轉帳傳票**快速編輯器（調整分錄用），共用同一匯出管線。

## 1. 資料來源（全部已存在，零遷移）

| 來源 | 位置 | 用途 |
|---|---|---|
| 動支單/請購單 | D1 `records`（`form_type` = expense/purchase，整筆 JSON 在 `data`） | 支出傳票的素材 |
| 歷史 SBA 傳票 | D1 `acc_voucher_entries`（3,172 筆，voucher_no = 年3+類1+流水5） | 匯入序號續號、立帳沖帳參照、科目清單 |
| 科目結構 | `subjects.json` / `/api/subjects`（專戶→businessPlans→purposes 三層） | 科目/用途/子目對應 |
| 銀行代碼 | `banks.json`（5,065 筆 `{code:"0061346", name:"…"}`，即 SBA fnxabank 格式） | F05 受款人銀行代碼 |
| 設定/狀態 | D1 `settings`（`acc_sba_*` key，經 `/api/acc`，寫入需 X-Admin-Pass） | 製票人帳號、已匯出紀錄 |

### 動支單 JSON 關鍵欄位（實測）
```
voucherNo "115-0434"、formType、acctCode "11010202"(保管款)/"11010201"(基金款)、acctName、
bpCode "21020312"(借方科目)、bpLabel、purposeCode "06"(子目或用途別)、purposeName、
purposeDesc(摘要)、total 5000、applyDateRoc、
payees:[{type:'vendor'|'bill'|…, bank:"0061346-合作金庫商業銀行佳里分行", acctNo, name, receiptType:'0'|'1'|'2'}]
voided、printed、savedAt
```

## 2. 傳票產生規則

### 2.1 分組（使用者規則：保管款與基金款分開）
- 勾選的單子依 `acctCode` 分組：`11010202 保管款專戶` 一組、`11010201 醫療基金專戶` 一組。
- 每組預設合併為 **一張支出傳票**（可切換「每單一張」）。
- SBA 規範同時要求：支出傳票的銀行存款專戶科目必為**貸方、唯一、序號1** —— 分組後天然滿足。

### 2.2 支出傳票（kind=2）明細
| seq | 借貸 | 科目 | 金額 | 其他欄位 |
|---|---|---|---|---|
| 1 | C | 該組 acctCode（專戶） | Σ各單 total | ttype=2、scode1=''、memo=彙總摘要 |
| 2… | D | 各單 bpCode | 單.total | memo=purposeDesc（截長）、ttype=2 |

借方欄位判定：
- `bpCode` 屬保管款群（210203xx、2102xx 代收/應付類）→ `fvchti_relate` = purposeCode（沖銷子目，僅 2 碼數字時），`fvchti_use` = ''；21020301 的 purpose 為中文名 → 併入摘要，不填 relate
- `bpCode` 屬費用/成本（5xxxxx）→ `fvchti_use` = purposeCode（用途別 4 碼），`fvchti_relate` = ''
  - **（審查修正）** use 為 `1XXX` 用人費用時，`fvchti_pkind` 人員類別**必填**（代碼須存在 SBA fnxwanormi；設定頁提供預設值＋逐列可改，未填擋匯出）
- `bpCode` 屬固定資產 12 科目（130101/130201/130301/130401/130501/130601/130701/130801/130901/130902/130903/130904）→ 歸屬性質必選＋23~29 計畫欄位（byear/code1~4/name3~4）**未填擋匯出**（規格附註「需填入」）
- `fvchti_scode1` 歸屬性質：**（審查修正）欄位表標 Required、官方範例 3 個銀行列有 1 列填 55000** → 一律預設 `55000 一般`（含銀行列）；固定資產科目依內嵌代碼表必選（購置情境預設 `10031 資產增置-實支數`）；710103 依表必選無 55000。
- `fvchti_bcode` 預算科目 4 碼：**（審查修正・高風險）官方範例每列皆有值**（110102→1112、410102→4112、210202→2122、420298→422Y）。維護「EAS→預算科目」對照表（設定頁可編輯、存 D1 settings），種子值以規律推導（第1,2,4碼＋末碼，末2碼98→'Y'），匯出前須與 SBA『常用會計科目設定』核對。

### 2.3 受款人 F05（僅 kind=2/5 需要）
每張支出傳票的受款人 = 各動支單 `payees[]` 展開：
- `fpaylist_payname` = payee.name（bill 型無名 → 預覽表必填提醒）
- `fpaylist_account` = acctNo；`fpaylist_userbank` = bank 字串 `-` 前段（7 碼）；`fpaylist_bankna` = `-` 後段
- **付款方式（使用者規則）**：
  - 銀行名稱含「佳里區農會」（含分部）→ `1 存帳`
  - 其他銀行有帳號 → `6 電匯(e企)`
  - `type:'bill'` 持繳費單（代繳）→ SBA 無「代繳」代碼，預設 `2 自領`，**預覽可改**（此假設需使用者確認）
- `fpaylist_amt` = 該受款人金額（單一受款人=單.total；多受款人依原單金額）
- `fpaylist_usedoc` = purposeDesc；`fpaylist_rev` = receiptType（0/1/2）
- **（審查修正）檢核基準照規格原文**：Σ受款人應領金額 = Σ(F04 借方、實沖別=2 之金額)（本工具產生之傳票該值＝銀行貸方金額，但檢核以規格用語實作）
- `rev=2 統一發票` 時 → 預覽提供發票號/日期/金額欄 → 產 F07；同一受款人 Σ發票金額須＝應領金額（未填擋匯出）
  - **（審查修正）F05 端**：rev=2 → `fpaylist_invno`/`invdate` 留空、`invamt`=發票總額；rev=0/1 → invdate 可填
  - **（審查修正）F07 元素名**：欄位表為 `finvoice_invdate/invamt`，官方範例卻用 `finvoice_date/amt`——採**欄位表**命名，列為首批實測驗證項

### 2.4 沖帳關聯 F06（選配）
借方為立沖科目（210203xx/210205/210202）時，該列可選「沖前立帳」：
- 候選清單：`acc_voucher_entries` 同科目（＋同子目）之貸方列（本年度），顯示 voucher_no/seq/日期/摘要/金額
- 選定 → 產 F06 一列（acc_year1/vch_kind1(=voucher_no第4碼)/vchrno1/seq1/amt）
- 不選 → 不產 F06（SBA 端仍可手動沖）；**檢核順序**：立帳傳票須已存在 SBA，符合官方操作說明第 6 點

### 2.5 轉帳傳票（kind=3）快速編輯器
- 手動加列：科目（下拉=歷史 distinct subjects＋subjects.json）、借/貸、金額、用途別/子目、摘要
- 製票日=入帳日（SBA 規範 kind=3 fvchmi_date 同入帳日期）
- 借貸平衡即時檢核；同一匯出批次可與支出傳票混批（F03/F04 同檔多 kind 合法，官方範例即混排）

## 3. 匯入資料序號與批次

- `fvchmi_importrecno` = `年度(3) + kind(1) + 流水(5)`，預設接續 `acc_voucher_entries` 同年同 kind 最大流水＋已匯出草稿，**可編輯**；一批內唯一，且不得撞已匯出序號。
- 檔名：`F03/F04/F05/F06/F07 + YYYMMDD(民國處理日期7碼) + 批號2碼(1-9A-Z)` + `.XML`；XML root 元素 = 檔名主體，列元素 = `root_row`。
- ZIP：純前端產生（store 無壓縮 + CRC32，自寫 ~60 行，不加相依套件），內含本批有資料的 F 檔。F99 由 SBA 端產生，非我方輸出。
- 匯出成功 → `acc_sba_exported`（settings）記 `{recordId: {importrecno, batchTag, exportedAt}}`；清單預設隱藏已匯出單（可顯示）。

## 4. XML 細節（依官方 doc 逐欄）

- 宣告：`<?xml version='1.0' encoding='UTF-8' standalone='no' ?>`；UTF-8；跳脫 `& < >`。
- 金額 2 位小數（`13345.00`）、數量 6 位（`0.000000`）；未用金額欄填 `0.00`。
- F03 欄序：year,kind,importrecno,mvchno,pay_date,date,damt,camt,scode1,rnum,memo,urgent（＋kind=5 才有 memo1；本所不用 kind5）。
  - `fvchmi_scode1`（傳票性質）= `1 一般性質傳票`；damt=camt=Σ借=Σ貸；urgent 輸出空（照範例）、rnum 預設 0。
  - **（審查修正）`fvchmi_date` 入帳日**：已入帳→實際入帳日（預設=製票日可改）；**未入帳→`9991231`**；UI 提供切換。kind=3 入帳日=製票日。
- F04 欄序照官方**範例** 30 元素（bcode 依對照表輸出、buse 留空）。
- 長度檢核：規格未明訂位元組基準——**保守假設**以 Big5 位元組截斷（比字元數嚴，不會超長）：memo 100B、vch_memo/usedoc 1000B、payname 200B，超長截斷＋警示。
- 前提假設：本基金未啟用「傳票輸入部門別」與「營運項目」（depart/entry 留空；若 SBA 檢核要求再補）。
- 日期一律民國 7 碼 `YYYMMDD`。

## 5. UI / 頁面

`sba.html`（新檔，沿用 design.css / eaf-tokens.css / acc.html 登入守門與 top-bar 樣式）：
1. **📋 動支單→支出傳票**（主分頁）：期間篩選（預設近 60 天）、狀態（未匯出/全部）、全選/勾選、右側即時分組預覽（保管款 n 筆 $x／基金款 m 筆 $y）
2. **🧾 傳票預覽/編輯**：產生後逐張顯示 F03 頭＋F04 明細＋F05 受款人（可編輯：日期、摘要、付款方式、發票、沖帳連結、scode1）＋檢核紅黃燈
3. **🔁 轉帳傳票**：快速分錄編輯器
4. **⬇️ 匯出**：批號選擇、下載 ZIP、標記已匯出（需管理密碼，沿用 acc_admin_pass 機制）
5. **⚙️ 設定**：SBA 製票人帳號(mvchno)、付款方式規則開關

導覽：acc.html top-bar 加一個 `📤 SBA傳票` 連結（一行改動）；版次 acc/admin/index 同步 bump。

## 6. 明確不做（v1）／留給下一棒
- kind=1 收入傳票、kind=4/5/6（本所主要痛點是支出與轉帳）
- F08 繳款人（隨 kind=1）
- F99 回讀自動回寫 `acc_voucher_entries`（設計預留：匯出紀錄已存 importrecno，回寫僅需對照 F99 txt）
- 固定資產 23~29 計畫欄位自動帶入（fnswacapital 資料不在我方）

## 7. 風險與待使用者確認
1. 「持繳費單→代繳」在 SBA 付款方式無對應碼，暫對 `2 自領`（可改）。
2. `fvchti_bcode/buse`（範例有、表格無）輸出空值——若 SBA 檢核拒收再移除。
3. 匯入序號是否須避開 SBA 既有傳票號段——採「接續現有號」策略，SBA 轉製時自取正式號（F99），如衝突改高段（如 90001 起）即可。
4. F06 沖帳為選配，首批建議先匯 1 張小額傳票驗證流程。

/* EAF 全站版號唯一來源。
   升版規則：
   1. 任何改動 → APP_VERSION 升 patch，且 sba-core.js 頂部 SBA_CORE_VERSION 同步（握手哨）。
   2. 「功能性」更新（要讓開啟中的使用者被提示更新）→ APP_FORCE_VERSION 一併設成同版號。
      小修/文案/樣式 → 只動 APP_VERSION，開啟中頁面不打擾（下次自然載入即最新）。 */
window.APP_VERSION = '5.7.9';
window.APP_FORCE_VERSION = '5.6.9';

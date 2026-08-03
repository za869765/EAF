/* ═══════════════════════════════════════════════════════════════
   sba-core.js — SBA 作業型「匯入傳票資料檔」產生核心（純邏輯、無 DOM）
   佳里區衛生所 醫療作業基金 ACC → SBA 傳票匯出
   規格依據：docs/SBA匯出傳票_設計.md ＋ SBA作業型-匯入傳票作業說明.doc
   由 sba.html 載入；Node 測試可直接 require（見檔尾 module.exports）
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* 版本＝EAF 全站版號（index/acc/admin/sba 同步）；sba.html 開機會核對，防快取新舊錯配 */
const SBA_CORE_VERSION = '5.6.9';

/* ── 民國日期工具 ─────────────────────────────────────────── */
/** Date → 民國7碼 YYYMMDD（如 1150131） */
function rocDate7(d) {
  const y = d.getFullYear() - 1911;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return String(y).padStart(3, '0') + m + dd;
}
/** "115/07/23"、"115年7月23日"、"2026-07-23"、"1150723" → 民國7碼；解析失敗回 '' */
function toRoc7(s) {
  if (!s) return '';
  s = String(s).trim();
  if (/^\d{7}$/.test(s)) return (+s.slice(0, 3) >= 100 && +s.slice(0, 3) <= 130) ? s : '';   /* 7碼也驗年段：擋 0260723 這類漏打 1 */
  let m = s.match(/^(\d{2,3})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})日?$/);
  if (m) {
    let y = +m[1]; if (y > 1911) y -= 1911;
    if (y < 100 || y > 130) return '';   /* 年碼合理範圍檢查：擋「26/7/23」這類漏打 1 的輸入（產出民國 26 年會直通 F05/F07） */
    return String(y).padStart(3, '0') + String(+m[2]).padStart(2, '0') + String(+m[3]).padStart(2, '0');
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return String(+m[1] - 1911).padStart(3, '0') + m[2] + m[3];
  return '';
}

/** 民國7碼日期差（b−a 天數）；任一無效（含 1150231 這類不存在日期）回 null */
function roc7DiffDays(a, b) {
  const p = (s) => {
    const m = String(s || '').match(/^(\d{3})(\d{2})(\d{2})$/);
    if (!m) return null;
    const t = Date.UTC(+m[1] + 1911, +m[2] - 1, +m[3]);
    const d = new Date(t);
    return (d.getUTCMonth() + 1 === +m[2] && d.getUTCDate() === +m[3]) ? t : null;
  };
  const da = p(a), db = p(b);
  return da == null || db == null ? null : Math.round((db - da) / 86400000);
}

/* ── Big5 位元組長度（SBA 為 Big5 系統，varchar 長度以 byte 計）──
   近似法：CJK/全形字元 2 byte、其餘 1 byte（Big5 全部雙位元組字皆 2B）*/
function big5Len(s) {
  let n = 0;
  for (const ch of String(s || '')) n += ch.codePointAt(0) > 0x7f ? 2 : 1;
  return n;
}
/** 依 Big5 byte 上限截斷（不切半字） */
function truncBig5(s, maxBytes) {
  s = String(s || '');
  let n = 0, out = '';
  for (const ch of s) {
    const w = ch.codePointAt(0) > 0x7f ? 2 : 1;
    if (n + w > maxBytes) break;
    n += w; out += ch;
  }
  return out;
}

/* ── XML ─────────────────────────────────────────────────── */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    /* XML 1.0 非法控制字元（Excel 匯入資料常見殘留）→ 剝除；換行/歸位 → 空白 */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** 金額：2 位小數字串 */
function fmt2(n) { return (Math.round((+n || 0) * 100) / 100).toFixed(2); }
/** 數量：6 位小數字串 */
function fmt6(n) { return (Math.round((+n || 0) * 1e6) / 1e6).toFixed(6); }

/**
 * 依欄位序列產生一個 XML 檔內容
 * @param {string} rootName 如 'F031150723AA'
 * @param {Array<Object>} rows 每列 {欄位名: 值}（值已是最終字串）
 * @param {Array<string>} fieldOrder 元素輸出順序
 */
function buildXml(rootName, rows, fieldOrder) {
  const lines = [`<?xml version='1.0' encoding='UTF-8' standalone='no' ?>`, `<${rootName}>`];
  for (const row of rows) {
    lines.push(`  <${rootName}_row>`);
    for (const f of fieldOrder) {
      lines.push(`    <${f}>${xmlEscape(row[f])}</${f}>`);
    }
    lines.push(`  </${rootName}_row>`);
  }
  lines.push(`</${rootName}>`);
  return lines.join('\r\n') + '\r\n';
}

/* ── 欄位順序（依官方範例 XML；F04 含表格未列但範例存在的 bcode/buse）── */
const F03_FIELDS = ['fvchmi_year','fvchmi_kind','fvchmi_importrecno','fvchmi_mvchno',
  'fvchmi_pay_date','fvchmi_date','fvchmi_damt','fvchmi_camt','fvchmi_scode1',
  'fvchmi_rnum','fvchmi_memo','fvchmi_urgent'];
const F04_FIELDS = ['fvchti_year','fvchti_kind','fvchti_importrecno','fvchti_dtlseq',
  'fvchti_dc','fvchti_code','fvchti_bcode','fvchti_use','fvchti_buse','fvchti_depart',
  'fvchti_entry','fvchti_pkind','fvchti_contno','fvchti_num','fvchti_famt','fvchti_vamt',
  'fvchti_amt','fvchti_ttype','fvchti_relate','fvchti_scode1','fvchti_vch_memo',
  'fvchti_bcashcode','fvchti_byear','fvchti_code1','fvchti_code2','fvchti_code3',
  'fvchti_code4','fvchti_name3','fvchti_name4','fvchti_loaner'];
const F05_FIELDS = ['fpaylist_year','fpaylist_kind','fpaylist_importrecno','fpaylist_dtlseq',
  'fpaylist_payname','fpaylist_addr','fpaylist_tel','fpaylist_userna','fpaylist_account',
  'fpaylist_userbank','fpaylist_bankna','fpaylist_payway','fpaylist_amt','fpaylist_usedoc',
  'fpaylist_memo','fpaylist_email','fpaylist_remark1','fpaylist_remark2','fpaylist_checkno',
  'fpaylist_compno','fpaylist_rev','fpaylist_invno','fpaylist_invdate','fpaylist_invamt'];
const F06_FIELDS = ['fvchtir_year','fvchtir_kind','fvchtir_importrecno','fvchtir_dtlseq',
  'fvchtir_type','fvchtir_acc_year1','fvchtir_vch_kind1','fvchtir_vchrno1','fvchtir_seq1',
  'fvchtir_amt'];
const F07_FIELDS = ['finvoice_year','finvoice_kind','finvoice_importrecno','finvoice_dtlseq',
  'finvoice_dtl2seq','finvoice_invno','finvoice_invdate','finvoice_invamt','finvoice_compno',
  'finvoice_name','finvoice_distribution','finvoice_reason'];

/* ═══════════════════════════════════════════════════════════
   傳票資料模型（normalized voucher）
   {
     year:'115', kind:'2', importrecno:'115200252', mvchno:'sba帳號',
     payDate:'1150723', postDate:'1150723', memo:'…', rnum:0, urgent:'',
     lines:[{ seq:1, dc:'C', code:'11010202', use:'', relate:'', scode1:'',
              num:0, amt:5000, ttype:'2', memo:'…',
              offset:{year:'115', kind:'1', vchrno:'115100005', seq:3, amt:5000}|null }],
     payees:[{ seq:1, name:'…', addr:'', tel:'', userna:'', account:'', userbank:'',
               bankna:'', payway:'1', amt:5000, usedoc:'…', memo:'', email:'',
               remark1:'', remark2:'', checkno:'', compno:'', rev:'0',
               invno:'', invdate:'', invamt:0,
               invoices:[{invno,invdate,invamt,compno,name,distribution,reason}] }]
   }
   ═══════════════════════════════════════════════════════════ */

/** 傳票檢核：回傳 {errors:[], warnings:[]} */
function validateVoucher(v, opt) {
  opt = opt || {};
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  const tag = `傳票 ${v.importrecno || '(未編號)'}`;

  if (!/^\d{3}$/.test(v.year)) E(`${tag}：會計年度須為民國3碼`);
  if (!['1','2','3','4','5','6'].includes(String(v.kind))) E(`${tag}：傳票類別不合法`);
  if (!/^\d{9}$/.test(String(v.importrecno))) E(`${tag}：匯入資料序號須為9碼（年3+類1+流水5）`);
  else {
    if (!String(v.importrecno).startsWith(String(v.year) + String(v.kind)))
      W(`${tag}：匯入序號前4碼(${String(v.importrecno).slice(0,4)})與年度+類別(${v.year}${v.kind})不一致`);
  }
  if (!v.mvchno) E(`${tag}：製票人（SBA帳號）未設定`);
  if (!/^\d{7}$/.test(v.payDate)) E(`${tag}：製票日期須為民國7碼`);
  if (!/^\d{7}$/.test(v.postDate)) E(`${tag}：入帳日期須為民國7碼（未入帳填9991231）`);
  if (String(v.kind) === '3' && v.postDate !== v.payDate)
    W(`${tag}：轉帳傳票入帳日期應同製票日期（規格 F03 欄06 註2）`);
  if (/^\d{7}$/.test(String(v.payDate)) && /^\d{3}$/.test(String(v.year)) && String(v.payDate).slice(0, 3) !== String(v.year))
    W(`${tag}：製票日期年度(${String(v.payDate).slice(0, 3)})與會計年度(${v.year})不一致——跨年補帳請確認年度`);
  if (big5Len(v.memo) > 100) W(`${tag}：傳票總摘要超過100位元組，將截斷（明細摘要上限1000B、總摘要僅100B）`);

  const lines = v.lines || [];
  if (!lines.length) { E(`${tag}：無明細`); return { errors, warnings }; }

  let d = 0, c = 0;
  lines.forEach((L) => { if (L.dc === 'D') d += +L.amt || 0; else c += +L.amt || 0; });
  d = Math.round(d * 100) / 100; c = Math.round(c * 100) / 100;
  if (d !== c) E(`${tag}：借貸不平衡（借 ${d} ≠ 貸 ${c}）`);
  if (d <= 0) E(`${tag}：金額為 0`);

  /* 銀行存款專戶規則（kind 1/2/5） */
  const isBank = (code) => String(code).startsWith('110102');
  const bankLines = lines.filter((L) => isBank(L.code));
  /* 轉帳傳票（非上線開帳）不可存在現金/銀行科目（規格 F04 欄06 註2） */
  if (String(v.kind) === '3' && String(v.scode1 || '1') !== '4') {
    const cash = lines.filter((L) => /^1101/.test(String(L.code)));
    if (cash.length) E(`${tag}：轉帳傳票不可有現金/銀行存款科目（${cash.map((L) => L.code).join('、')}）——請改用現金轉帳傳票或於 SBA 端處理`);
  }
  if (['1','2','5'].includes(String(v.kind))) {
    if (bankLines.length !== 1) E(`${tag}：銀行存款專戶科目須恰好一列（現有 ${bankLines.length} 列）`);
    else {
      const B = bankLines[0];
      if (B.seq !== 1) E(`${tag}：銀行存款專戶列須為序號1`);
      const wantDc = String(v.kind) === '1' ? 'D' : 'C';
      if (B.dc !== wantDc) E(`${tag}：銀行存款專戶列借貸別應為 ${wantDc === 'D' ? '借' : '貸'}`);
    }
  }

  lines.forEach((L) => {
    const lt = `${tag} 序號${L.seq}`;
    if (!L.code) E(`${lt}：會計科目空白`);
    if (!['D','C'].includes(L.dc)) E(`${lt}：借貸別須為 D/C`);
    if (!(+L.amt > 0)) E(`${lt}：金額須大於 0`);
    if (String(v.kind) !== '3' && !L.ttype) E(`${lt}：實沖別必填（1沖付/2實收付）`);
    if (big5Len(L.memo) > 1000) W(`${lt}：摘要超過1000位元組，將截斷`);
    if (!L.bcode) W(`${lt}：預算科目(bcode)未設定——官方範例每列皆有值，請於設定頁核對科目對照`);
    /* 用途別 1XXX 用人費用 → 人員類別必填（規格 F04 欄12） */
    if (/^1\d{3}$/.test(L.use || '') && !L.pkind)
      E(`${lt}：用途別 ${L.use} 屬用人費用，須填人員類別代碼(pkind)`);
    /* 固定資產 12 科目：歸屬性質＋23~29 計畫欄位（規格附註「需填入」） */
    const code6 = String(L.code).slice(0, 6);
    if (FIXED_ASSET_CODES.includes(code6)) {
      if (!L.scode1) E(`${lt}：固定資產科目須選擇歸屬性質代碼`);
      if (!L.byear || !L.code1 || !L.code2 || !L.code3)
        E(`${lt}：固定資產科目須填預算起始年度/計畫類型/種類/代號（23~29欄）`);
      if (!L.name3) W(`${lt}：固定資產科目建議填計畫名稱`);
    }
    /* v5.4.3 實測：支出傳票借方為 2102 立沖科目時，SBA 匯入「強制」要求沖銷資料（F06），
       未連結會整批報「沖銷資料[]-序號[0]資料不存在或已註銷」→ 工坊端提前擋 */
    if (String(v.kind) === '2' && L.dc === 'D' && /^2102/.test(String(L.code)) && !L.offset)
      E(`${lt}：立沖科目 ${L.code} 須連結沖帳——點該列「沖帳」選原立帳傳票貸方列（SBA 匯入必要）`);
    /* 轉帳傳票沖方立沖科目未連結先警告（kind2 借方2102實測必擋、kind3 未實測故不硬擋）：
       負債(2102)沖=借方；資產(110305應收/180705保證金)沖=貸方（借方=立帳，不需沖帳） */
    if (String(v.kind) === '3' && !L.offset
      && ((L.dc === 'D' && /^2102/.test(String(L.code))) || (L.dc === 'C' && /^(110305|180705)/.test(String(L.code)))))
      W(`${lt}：轉帳傳票${L.dc === 'D' ? '借' : '貸'}方立沖科目 ${L.code} 未連結沖帳——建議於預覽點「沖帳」連結原立帳，SBA 端可能要求 F06 沖銷資料`);
    if (L.offset) {
      if (!/^\d{3}$/.test(L.offset.year) || !L.offset.vchrno || !(+L.offset.seq >= 1))
        E(`${lt}：沖帳關聯資料不完整（年度/傳票號/項次）`);
      if (L.offset.max != null && +L.offset.amt > +L.offset.max)
        E(`${lt}：沖帳金額 ${L.offset.amt} 超過立帳可沖金額 ${L.offset.max}`);
      if (+L.offset.amt !== +L.amt) W(`${lt}：沖帳金額(${L.offset.amt})與明細金額(${L.amt})不同（部分沖銷）`);
      /* v5.4.9 實測：F04 沖銷科目子目(relate)須與被沖立帳列子目一致（立帳無子目則須留空），
         否則 SBA 報「沖銷科目子目[]必須是在沖銷科目子目代碼建檔」 */
      if (L.offset.sub != null && String(L.relate || '') !== String(L.offset.sub))
        E(`${lt}：沖銷科目子目(${L.relate || '空'})須與被沖立帳子目(${L.offset.sub || '空'})一致——重選沖帳可自動帶入`);
      if (L.offset.sub == null && /^2102/.test(String(L.code)))
        W(`${lt}：被沖立帳不在 D1 歷史分錄，無法確認子目——請核對子目欄（現值「${L.relate || '空'}」）與 SBA 立帳列一致`);
    }
  });

  /* 受款人檢核（kind 2/5 有受款人時） */
  const payees = v.payees || [];
  if (payees.length && ['1','2','5'].includes(String(v.kind))) {
    let psum = 0;
    payees.forEach((P) => {
      const pt = `${tag} 受款人${P.seq}`;
      if (!P.name) E(`${pt}：名稱空白（持繳費單請填入實際受款單位）`);
      psum += +P.amt || 0;
      if (P.rev === '2') {
        const invs = P.invoices || [];
        if (!invs.length) E(`${pt}：單據類別為統一發票，須填發票明細（或改單據類別）`);
        else {
          const isum = invs.reduce((s, iv) => s + (+iv.invamt || 0), 0);
          if (Math.round(isum * 100) !== Math.round((+P.amt || 0) * 100))
            E(`${pt}：發票金額合計 ${isum} ≠ 應領金額 ${P.amt}`);
          invs.forEach((iv) => {
            /* F07 發票日期必填且須為「存在的」民國7碼日期（年段 100~130）：缺漏、漏打 1（0260723）、
               或不存在日期（1150231/1151332，用 roc7DiffDays 自比對驗曆法）SBA 匯入會被拒 */
            const d7 = String(iv.invdate || '');
            if (!/^\d{7}$/.test(d7) || +d7.slice(0, 3) < 100 || +d7.slice(0, 3) > 130 || roc7DiffDays(d7, d7) !== 0)
              E(`${pt}：發票 ${iv.invno || '(未填號碼)'} 日期缺漏或無效（${d7 || '空白'}，須為存在的民國7碼日期如 1150723）`);
            const gap = roc7DiffDays(iv.invdate, v.payDate);
            if (gap != null && gap > 15 && !iv.reason)
              W(`${pt}：發票日期 ${iv.invdate} 距製票日逾15日（${gap}天），F07 將自動填制式原因（採購法73-1）`);
          });
        }
      }
    });
    psum = Math.round(psum * 100) / 100;
    /* 規格：Σ受款人應領金額 = F04 實沖別2 之實付(收)金額合計
       kind=2/5：即「非銀行列之借方、ttype=2」合計（銀行列本身不計） */
    const paidSum = Math.round(lines
      .filter((L) => !isBank(L.code) && L.dc === 'D' && (L.ttype || '2') === '2')
      .reduce((s, L) => s + (+L.amt || 0), 0) * 100) / 100;
    if (psum !== paidSum)
      E(`${tag}：受款人金額合計 ${psum} ≠ 明細實付(實沖別2)合計 ${paidSum}`);
  }
  return { errors, warnings };
}

/** 批次檢核（含跨傳票唯一性） */
function validateBatch(vouchers, opt) {
  const errors = [], warnings = [];
  const seen = new Set();
  const existing = new Set((opt && opt.existingRecnos) || []);
  vouchers.forEach((v) => {
    const r = validateVoucher(v, opt);
    errors.push(...r.errors); warnings.push(...r.warnings);
    const key = String(v.importrecno);
    if (seen.has(key)) errors.push(`匯入序號 ${key} 重複`);
    seen.add(key);
    if (existing.has(key)) errors.push(`匯入序號 ${key} 已使用過（曾匯出或已存在傳票）`);
  });
  return { errors, warnings };
}

/* ── 預算科目(bcode)推導 ──────────────────────────────────
   官方範例規律：110102→1112、410102→4112、210202→2122、420298→422Y
   即取 EAS 6碼的第1,2,4碼＋第6碼（末2碼為98時以'Y'表示）。
   僅為種子值，實際對照須於設定頁與 SBA「常用會計科目設定」核對。 */
function guessBcode(easCode) {
  const c = String(easCode || '').slice(0, 6);
  if (!/^\d{6}$/.test(c)) return '';
  const tail = c.slice(4, 6) === '98' ? 'Y' : c[5];
  return c[0] + c[1] + c[3] + tail;
}

/* 固定資產科目（規格附註明列 12 科目：需填 23~29 計畫欄位） */
const FIXED_ASSET_CODES = ['130101','130201','130301','130401','130501','130601',
  '130701','130801','130901','130902','130903','130904'];

/* ── 傳票 → 各 F 檔 rows ───────────────────────────────── */
function voucherToF03Row(v) {
  const damt = (v.lines || []).filter((L) => L.dc === 'D').reduce((s, L) => s + (+L.amt || 0), 0);
  const camt = (v.lines || []).filter((L) => L.dc === 'C').reduce((s, L) => s + (+L.amt || 0), 0);
  return {
    fvchmi_year: v.year, fvchmi_kind: v.kind, fvchmi_importrecno: v.importrecno,
    fvchmi_mvchno: v.mvchno, fvchmi_pay_date: v.payDate, fvchmi_date: v.postDate,
    fvchmi_damt: fmt2(damt), fvchmi_camt: fmt2(camt),
    fvchmi_scode1: v.scode1 || '1',
    fvchmi_rnum: String(v.rnum ?? 0),
    fvchmi_memo: truncBig5(v.memo, 100),
    fvchmi_urgent: v.urgent || '',
  };
}
function voucherToF04Rows(v) {
  return (v.lines || []).map((L) => ({
    fvchti_year: v.year, fvchti_kind: v.kind, fvchti_importrecno: v.importrecno,
    fvchti_dtlseq: String(L.seq), fvchti_dc: L.dc, fvchti_code: L.code,
    fvchti_bcode: L.bcode || '', fvchti_use: L.use || '', fvchti_buse: '',
    fvchti_depart: L.depart || '', fvchti_entry: L.entry || '', fvchti_pkind: L.pkind || '',
    fvchti_contno: '', fvchti_num: fmt6(L.num || 0), fvchti_famt: fmt2(0),
    fvchti_vamt: fmt2(L.amt), fvchti_amt: fmt2(L.amt),
    fvchti_ttype: String(v.kind) === '3' ? '' : (L.ttype || '2'),
    fvchti_relate: L.relate || '', fvchti_scode1: L.scode1 || '',
    fvchti_vch_memo: truncBig5(L.memo, 1000), fvchti_bcashcode: L.bcashcode || '',
    fvchti_byear: L.byear || '', fvchti_code1: L.code1 || '', fvchti_code2: L.code2 || '',
    fvchti_code3: L.code3 || '', fvchti_code4: L.code4 || '',
    fvchti_name3: L.name3 || '', fvchti_name4: L.name4 || '', fvchti_loaner: L.loaner || '',
  }));
}
function voucherToF05Rows(v) {
  return (v.payees || []).map((P) => ({
    fpaylist_year: v.year, fpaylist_kind: v.kind, fpaylist_importrecno: v.importrecno,
    fpaylist_dtlseq: String(P.seq), fpaylist_payname: truncBig5(P.name, 200),
    fpaylist_addr: truncBig5(P.addr || '', 200), fpaylist_tel: P.tel || '',
    fpaylist_userna: truncBig5(P.userna || P.name, 200), fpaylist_account: P.account || '',
    fpaylist_userbank: P.userbank || '', fpaylist_bankna: truncBig5(P.bankna || '', 100),
    fpaylist_payway: P.payway || '', fpaylist_amt: fmt2(P.amt),
    fpaylist_usedoc: truncBig5(P.usedoc || '', 1000), fpaylist_memo: truncBig5(P.memo || '', 1000),
    /* 劃線/禁背固定規則（使用者指定無例外）：自領→劃線0，其餘→1；禁背一律 1 */
    fpaylist_email: P.email || '', fpaylist_remark1: P.payway === '2' ? '0' : '1',
    fpaylist_remark2: '1', fpaylist_checkno: P.checkno || '',
    fpaylist_compno: P.compno || '', fpaylist_rev: P.rev || '',
    /* 規格：rev=2 統一發票 → invno 留空、invdate 留空、invamt=發票總額；rev=0/1 → invdate 可填 */
    fpaylist_invno: '',
    fpaylist_invdate: P.rev === '2' ? '' : (P.invdate || ''),
    fpaylist_invamt: fmt2(P.rev === '2'
      ? (P.invoices || []).reduce((s, iv) => s + (+iv.invamt || 0), 0)
      : (P.invamt || 0)),
  }));
}
function voucherToF06Rows(v) {
  const rows = [];
  (v.lines || []).forEach((L) => {
    if (!L.offset) return;
    rows.push({
      fvchtir_year: v.year, fvchtir_kind: v.kind, fvchtir_importrecno: v.importrecno,
      fvchtir_dtlseq: String(L.seq), fvchtir_type: '2',
      fvchtir_acc_year1: L.offset.year, fvchtir_vch_kind1: L.offset.kind,
      fvchtir_vchrno1: L.offset.vchrno, fvchtir_seq1: String(L.offset.seq),
      fvchtir_amt: fmt2(L.offset.amt),
    });
  });
  return rows;
}
function voucherToF07Rows(v) {
  const rows = [];
  (v.payees || []).forEach((P) => {
    if (P.rev !== '2') return; /* 僅統一發票受款人產 F07（rev 改回 0/1 時發票殘留不得輸出） */
    (P.invoices || []).forEach((iv, i) => {
      /* v5.5.2 發票日期距製票日逾15日：SBA 要求填原因（採購法73-1），F07 原因欄空白疑致 SBA 剔除日期/金額待補登 */
      const gap = roc7DiffDays(iv.invdate, v.payDate);
      rows.push({
        finvoice_year: v.year, finvoice_kind: v.kind, finvoice_importrecno: v.importrecno,
        finvoice_dtlseq: String(P.seq), finvoice_dtl2seq: String(i + 1),
        finvoice_invno: iv.invno || '', finvoice_invdate: iv.invdate || '',
        finvoice_invamt: fmt2(iv.invamt || 0), finvoice_compno: iv.compno || '',
        finvoice_name: truncBig5(iv.name || (P.rev === '2' ? P.name : '') || '', 200),
        finvoice_distribution: iv.distribution || '0',
        finvoice_reason: truncBig5(iv.reason || (gap != null && gap > 15 ? '核銷請款作業時程，發票日期與製票日相距逾15日' : ''), 1000),
      });
    });
  });
  return rows;
}

/**
 * 批次匯出：vouchers[] + 處理日期(民國7碼) + 批號(2碼) → {files:{name:string→content}, skipped:[]}
 * 只輸出有資料的檔；F99 由 SBA 產生。
 */
function buildExportFiles(vouchers, procDate7, batchTag) {
  if (!/^\d{7}$/.test(procDate7)) throw new Error('處理日期須為民國7碼 YYYMMDD');
  if (!/^[1-9A-Z]{2}$/.test(batchTag)) throw new Error('批號須為2碼（1-9、A-Z）');
  const suffix = procDate7 + batchTag;
  const f03 = [], f04 = [], f05 = [], f06 = [], f07 = [];
  vouchers.forEach((v) => {
    f03.push(voucherToF03Row(v));
    f04.push(...voucherToF04Rows(v));
    if (['1','2','5'].includes(String(v.kind))) f05.push(...voucherToF05Rows(v));
    f06.push(...voucherToF06Rows(v));
    if (['2','5'].includes(String(v.kind))) f07.push(...voucherToF07Rows(v));
  });
  const files = {};
  files[`F03${suffix}.XML`] = buildXml(`F03${suffix}`, f03, F03_FIELDS);
  files[`F04${suffix}.XML`] = buildXml(`F04${suffix}`, f04, F04_FIELDS);
  if (f05.length) files[`F05${suffix}.XML`] = buildXml(`F05${suffix}`, f05, F05_FIELDS);
  if (f06.length) files[`F06${suffix}.XML`] = buildXml(`F06${suffix}`, f06, F06_FIELDS);
  if (f07.length) files[`F07${suffix}.XML`] = buildXml(`F07${suffix}`, f07, F07_FIELDS);
  return { files };
}

/* ── ZIP（store 無壓縮）───────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  /* Node fallback */
  return new Uint8Array(Buffer.from(str, 'utf8'));
}
/** DOS 日期時間（ZIP header 用） */
function dosDateTime(d) {
  d = d || new Date();
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}
/**
 * 產生 ZIP（store）。files: {檔名: 字串內容}。回傳 Uint8Array。
 * 檔名以 UTF-8 寫入並設 UTF-8 flag(bit11)。
 */
function buildZip(files, now) {
  const { date, time } = dosDateTime(now);
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of Object.entries(files)) {
    const nameB = utf8Bytes(name);
    const data = typeof content === 'string' ? utf8Bytes(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0),
    ]);
    chunks.push(local, nameB, data);
    central.push({ nameB, crc, size: data.length, offset });
    offset += local.length + nameB.length + data.length;
  }
  const centralStart = offset;
  for (const e of central) {
    const hdr = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(date), ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.offset),
    ]);
    chunks.push(hdr, e.nameB);
    offset += hdr.length + e.nameB.length;
  }
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - centralStart), ...u32(centralStart), ...u16(0),
  ]);
  chunks.push(end);
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* ═══════════════════════════════════════════════════════════
   動支單/請購單 → 支出傳票 對應層（整合審查 P1~P16 落實）
   ═══════════════════════════════════════════════════════════ */

/** 從 payee.bank "0061346-合作金庫商業銀行佳里分行" 取出 {code, name} */
function splitBank(bankStr) {
  const s = String(bankStr || '');
  const i = s.indexOf('-');
  if (i === 7 && /^\d{7}$/.test(s.slice(0, 7))) return { code: s.slice(0, 7), name: s.slice(8) };
  return { code: '', name: s };
}

/**
 * 付款方式判定（使用者規則）：
 *  佳里區農會/佳興分部（精確代碼白名單）→ 1 存帳；其他銀行有帳號 → 6 電匯(e企)；
 *  持繳費單(bill) → 代繳（SBA 無此碼，暫對 2 自領，預覽可改）
 */
function decidePayway(payee, farmCodes) {
  if (payee.type === 'bill') return '2';
  const { code, name } = splitBank(payee.bank);
  if (farmCodes.has(code) || /佳里區農會/.test(name)) return '1';
  if (payee.acctNo) return '6';
  return '2';
}

/* ── FNWACX0170 受款人匯入檔（xlsx 12 欄；模板=受(繳)款人匯入 工作表）── */
const FNWACX_SHEET = '受(繳)款人匯入';
const FNWACX_FUND = '310400121';
const FNWACX_HEADERS = ['受款人代碼\n(長度10)', '受款人名稱\n(長度200)', '受款人電話\n(長度30)',
  '受款人地址\n(長度200)', '領取方式\n(長度1，參閱備註說明)', '銀行帳號\n(長度14)', '戶名\n(長度200)',
  '金融機構分行代號\n(長度7)', 'email\n(長度50)', '統一編號\n(長度12)', '收據別\n(長度1，參閱備註說明)',
  '指定兌付銀行分行代號\n(長度7)'];
/** 台灣公司統一編號檢核（8 碼＋加權檢查；第 7 碼為 7 之特例）。
 *  SBA 匯入對「統一編號」欄做邏輯檢查——身分證字號放進去會整批中止（實測 v5.1.8）。 */
function isValidGui(no) {
  if (!/^\d{8}$/.test(no)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = +no[i] * w[i];
    sum += Math.floor(p / 10) + (p % 10);
  }
  return sum % 10 === 0 || (no[6] === '7' && (sum + 1) % 10 === 0);
}
/**
 * EAF 受款人主檔 → FNWACX0170 12 欄列。
 * 領取方式：佳里區農會帳戶→1 存入受款人帳戶；其他銀行有帳號→6 電匯；無帳號→2 自領。
 * 指定兌付：現況檔慣例，1/6 預設 6180069（佳里區農會），2 留空；可於 UI 逐列改。
 * 統一編號：僅「合格 8 碼公司統編」才填；身分證只放受款人代碼欄（SBA 統編欄有邏輯檢查）。
 */
function payeeToFnwacxRow(p, farmCodes) {
  const bk = splitBank(p.bank);
  const acct = String(p.acctNo || '').replace(/\D/g, '').slice(0, 14);
  const isFarm = farmCodes.has(bk.code) || /佳里區農會/.test(bk.name);
  const way = isFarm ? '1' : (acct ? '6' : '2');
  const code = String(p.code || '').trim().toUpperCase();
  return [code.slice(0, 10), String(p.name || '').trim(), '', '', way, acct,
    String(p.name || '').trim(), bk.code, '', isValidGui(code) ? code : '', '', way === '2' ? '' : '6180069'];
}
/** 受款人姓名正規化（比對用）：去空白＋大寫 */
function normPayeeName(s) { return String(s || '').replace(/\s/g, '').toUpperCase(); }
/** 既有 SBA 受款人現況（12 欄 rows，不含前兩列表頭）→ 比對索引。
 *  帳號鍵＝分行代號|完整帳號數字（不去前導零，避免異行同號誤判） */
function buildSbaPayeeIndex(rows) {
  const codes = new Set(), bankAccts = new Set(), names = new Set(), payeeCodes = new Set();
  for (const r of rows) {
    if (!r || !r[1]) continue;
    if (r[0]) { codes.add(String(r[0]).trim().toUpperCase()); payeeCodes.add(String(r[0]).trim().toUpperCase()); }
    if (r[9]) codes.add(String(r[9]).trim().toUpperCase());
    const a = String(r[5] || '').replace(/\D/g, '');
    if (a) bankAccts.add(String(r[7] || '').replace(/\D/g, '') + '|' + a);
    names.add(normPayeeName(r[1]));
    if (r[6]) names.add(normPayeeName(r[6]));
  }
  /* payeeCodes＝僅「受款人代碼」欄（SBA 匯入對此欄查重；統編欄不算）——實測 v5.1.9：代碼已存在→匯入報重複並中止 */
  return { codes, bankAccts, names, payeeCodes };
}
/** EAF 受款人是否已存在 SBA。
 *  SBA 為「一帳戶一列」（同一人可多列），故有帳號時只認「分行|帳號」——
 *  同一人新開帳戶須新增一列，不能因代碼已存在而略過。無帳號才退代碼/姓名。 */
function payeeExistsInSba(p, idx) {
  const a = String(p.acctNo || '').replace(/\D/g, '');
  if (a) return idx.bankAccts.has(splitBank(p.bank).code.replace(/\D/g, '') + '|' + a);
  const code = String(p.code || '').trim().toUpperCase();
  if (code) return idx.codes.has(code);
  return idx.names.has(normPayeeName(p.name));
}

/* ── FNWACX0170 官方模板重打包（v5.1.8）：資料填進範本原封 zip，結構=官方檔 ──
   背景：SheetJS 從零產檔於 SBA 匯入「無反應」；改以官方範本為底稿只填 A..L 值。 */
async function _inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** 解 zip（store/deflate）→ { name: Uint8Array }，保持中央目錄順序 */
async function unzipAll(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('非 zip 檔');
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {}, td = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip 中央目錄損壞');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = dv.getUint16(lho + 26, true), lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + csize);
    out[name] = method === 0 ? comp.slice() : await _inflateRaw(comp);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
/** 官方 FNWACX0170 範本 bytes + 12 欄資料列 → 匯入檔 bytes（僅填 A..L；rows 由第 3 列起） */
async function buildFnwacxFromTemplate(tplU8, rows) {
  const files = await unzipAll(tplU8);
  if (!files['xl/sharedStrings.xml'] || !files['xl/worksheets/sheet1.xml']) throw new Error('範本結構不符（缺 sharedStrings/sheet1）');
  const td = new TextDecoder();
  let ss = td.decode(files['xl/sharedStrings.xml']);
  let sh = td.decode(files['xl/worksheets/sheet1.xml']);
  const baseUnique = +ss.match(/uniqueCount="(\d+)"/)[1];
  const baseCount = +ss.match(/ count="(\d+)"/)[1];
  const addIdx = new Map();
  let refs = 0;
  const idxOf = (v) => { refs++; if (!addIdx.has(v)) addIdx.set(v, baseUnique + addIdx.size); return addIdx.get(v); };
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  for (let i = 0; i < rows.length; i++) {
    const r = 3 + i;
    const cells = COLS.map((col, j) => {
      const v = String(rows[i][j] == null ? '' : rows[i][j]).trim();
      return v ? `<c r="${col}${r}" s="2" t="s"><v>${idxOf(v)}</v></c>` : `<c r="${col}${r}" s="2"/>`;
    }).join('');
    const rowRe = new RegExp('(<row r="' + r + '"[^>]*>)([\\s\\S]*?)(</row>)');
    if (rowRe.test(sh)) {
      /* 既有列：移除原空白 A..L 儲存格、插入資料格（單字母欄名不會誤中 AA 等雙字母欄） */
      sh = sh.replace(rowRe, (_, open, body, close) =>
        open + cells + body.replace(new RegExp('<c r="[A-L]' + r + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)', 'g'), '') + close);
    } else {
      sh = sh.replace('</sheetData>', `<row r="${r}">${cells}</row></sheetData>`);
    }
  }
  const lastRow = Math.max(10, 2 + rows.length);
  sh = sh.replace(/<dimension ref="A1:AI\d+"\/>/, `<dimension ref="A1:AI${lastRow}"/>`);
  const sis = [...addIdx.keys()].map((v) => `<si><t xml:space="preserve">${xmlEscape(v)}</t></si>`).join('');
  ss = ss.replace(/ count="\d+"/, ` count="${baseCount + refs}"`)
    .replace(/uniqueCount="\d+"/, `uniqueCount="${baseUnique + addIdx.size}"`)
    .replace('</sst>', sis + '</sst>');
  const enc = new TextEncoder();
  files['xl/sharedStrings.xml'] = enc.encode(ss);
  files['xl/worksheets/sheet1.xml'] = enc.encode(sh);
  return buildZip(files);
}

/* 付款類別（＝分組維度）：1 農會存帳／6 電匯(e企)／2 繳費單代繳 */
const PAY_CAT_LABEL = { '1': '農會存帳', '6': '電匯(e企)', '2': '繳費單/代繳' };
const PAY_CAT_ORDER = ['1', '6', '2'];

/**
 * 解析一筆記錄的受款人（含金額比對與付款類別），供分組與預覽共用
 * @returns {payees:[], issues:[]}
 */
function resolvePayees(rec, ctx) {
  const issues = [];
  const recAmt = +rec.total || 0;
  let ps = Array.isArray(rec.payees) && rec.payees.length ? rec.payees
    : (rec.payee && rec.payee.type ? [rec.payee] : []);
  if (!ps.length) {
    issues.push({ recId: rec.id, level: 'error', msg: `${rec.voucherNo}：無受款人資料，請於預覽手動補齊` });
    ps = [{ type: 'manual' }];
  }
  /* 多受款人：items[].name ↔ payees[].name 對映金額（price 為字串） */
  let amtByName = null;
  if (ps.length > 1) {
    amtByName = {};
    for (const it of rec.items || []) {
      const nm = String(it.name || '').trim();
      amtByName[nm] = (amtByName[nm] || 0) + (+String(it.price || '').replace(/,/g, '') || 0);
    }
  }
  const payees = ps.map((p) => {
    const bk = splitBank(p.bank);
    let amt;
    if (ps.length === 1) amt = recAmt;
    else {
      amt = amtByName[String(p.name || '').trim()];
      if (amt == null) {
        issues.push({ recId: rec.id, level: 'error',
          msg: `${rec.voucherNo}：受款人「${p.name || '(未命名)'}」金額無法自動比對，請於預覽填入` });
        amt = 0;
      }
    }
    const rev = p.receiptType != null && p.receiptType !== '' ? String(p.receiptType) : '0';
    /* ctx.catOverride[recId]＝sba.html 六大格手動移組覆寫（整單強制同一付款類別） */
    const payway = (ctx.catOverride && ctx.catOverride[rec.id]) || decidePayway(p, ctx.farmCodes);
    /* v5.5.2 統一編號：由受款人主檔查（帳號優先、姓名後備；僅合格公司統編）→ F05 受款人統編 + F07 發票統編
       v5.5.3：廠商類＋普通收據時，EAF 單上填的統編（p.guiNo）優先於主檔（其餘情境忽略殘值） */
    const rawGui = rev === '1' && ['vendor','nonghui'].includes(String(p.type || ''))
      ? String(p.guiNo || '').trim() : '';
    const gui = isValidGui(rawGui) ? rawGui : (ctx.payeeGuiFor ? String(ctx.payeeGuiFor(p) || '') : '');
    const payee = {
      seq: 0, name: String(p.name || '').trim(),
      account: p.acctNo || '', userbank: bk.code,
      bankna: bk.code ? (ctx.bankNameByCode(bk.code) || bk.name) : bk.name,
      payway, amt, compno: gui,
      /* 支票劃線/禁背預設（使用者規則）：自領(2)→劃線0否/禁背1是；存帳/電匯→劃線1是/禁背1是 */
      remark1: payway === '2' ? '0' : '1', remark2: '1',
      usedoc: String(rec.purposeDesc || '').trim(), rev,
      srcType: p.type || '', srcRec: rec.voucherNo,
      /* bill 不再要求人工填名：產傳票時整張併為「交由佳里區農會代繳」單一受款人 */
      needsInput: p.type === 'manual' || (!p.name && p.type !== 'bill'),
    };
    if (rev === '2' && (p.invoiceNo || p.invoiceAmount)) {
      payee.invoices = [{ invno: p.invoiceNo || '', invdate: toRoc7(p.invoiceDate || ''),
        invamt: +String(p.invoiceAmount || '').replace(/,/g, '') || amt,
        compno: gui, name: payee.name }];
    }
    if (payee.needsInput)
      issues.push({ recId: rec.id, level: 'error',
        msg: `${rec.voucherNo}：受款人需人工填入名稱等欄位` });
    return payee;
  });
  const psum = Math.round(payees.reduce((s, p) => s + (+p.amt || 0), 0) * 100) / 100;
  if (psum !== Math.round(recAmt * 100) / 100)
    issues.push({ recId: rec.id, level: 'warn',
      msg: `${rec.voucherNo}：受款人金額合計 ${psum} ≠ 單金額 ${recAmt}，請於預覽調整` });
  return { payees, issues };
}

/**
 * 分組預覽（不配序號、不建傳票）：專戶 × 付款類別
 * @returns [{acct, cat, catLabel, recIds:Set, n, sum}]
 */
function planGrouping(records, ctx) {
  const map = new Map();
  for (const rec of records) {
    const acct = rec.acctCode || '';
    if (!acct) continue;
    const { payees } = resolvePayees(rec, ctx);
    for (const p of payees) {
      const key = acct + '|' + p.payway;
      if (!map.has(key)) map.set(key, { acct, cat: p.payway, catLabel: PAY_CAT_LABEL[p.payway] || p.payway, recIds: new Set(), sum: 0 });
      const g = map.get(key);
      g.recIds.add(rec.id); g.sum += +p.amt || 0;
    }
  }
  return [...map.values()]
    .map((g) => ({ ...g, n: g.recIds.size, sum: Math.round(g.sum * 100) / 100 }))
    .sort((a, b) => a.acct.localeCompare(b.acct) || PAY_CAT_ORDER.indexOf(a.cat) - PAY_CAT_ORDER.indexOf(b.cat));
}

/**
 * 動支單/請購單 → 支出傳票（kind=2）
 * 分組維度＝**專戶 × 付款類別**（農會存帳／電匯／繳費單代繳），最多 專戶數×3 張。
 * 單據類型（動支/請購）不作為分組依據。一張單若含多種付款類別的受款人，
 * 會依受款人金額拆到各自的傳票（借方金額同步拆分），確保每張傳票付款方式單純。
 * @param {Array} records 已勾選的 EAF 記錄（原始 JSON）
 * @param {Object} ctx {
 *   year:'115', payDate7:'1150727', postDate7:'1150727'|'9991231', mvchno,
 *   combine:true(同專戶同類別合併)|false(每單每類別各一張),
 *   bcodeFor(code)→string, farmCodes:Set<7碼>, defaultPkind:'',
 *   bankNameByCode(code)→官方名|'', nextRecno()→'115290001',
 *   acctNames:{'11010202':'保管款專戶',...}
 * }
 * @returns {vouchers:[], issues:[{recId,level,msg}]}
 */
function mapRecordsToVouchers(records, ctx) {
  const issues = [];
  const isCustodyBp = (bp) => /^2102/.test(bp) && bp !== '21020301';
  const useOf = (rec) => (/^\d{4}$/.test(rec.purposeCode || '') && !/^2102/.test(rec.bpCode) ? rec.purposeCode : '');
  const relateOf = (rec) => (isCustodyBp(rec.bpCode) && /^\d{2}$/.test(rec.purposeCode || '') ? rec.purposeCode : '');

  /* ① 解析每筆單的受款人 → ② 依 專戶 × 付款類別 分組 */
  const groups = new Map();
  for (const rec of records) {
    const acct = rec.acctCode || '';
    if (!acct) { issues.push({ recId: rec.id, level: 'error', msg: `${rec.voucherNo}：無專戶(acctCode)，略過` }); continue; }
    const { payees, issues: pIssues } = resolvePayees(rec, ctx);
    issues.push(...pIssues);
    const byCat = new Map();
    for (const p of payees) {
      if (!byCat.has(p.payway)) byCat.set(p.payway, []);
      byCat.get(p.payway).push(p);
    }
    if (byCat.size > 1)
      issues.push({ recId: rec.id, level: 'warn',
        msg: `${rec.voucherNo}：受款人含 ${[...byCat.keys()].map((c) => PAY_CAT_LABEL[c] || c).join('、')} 多種付款方式，已依金額拆入不同傳票` });
    for (const [cat, catPayees] of byCat) {
      const key = ctx.combine ? `${acct}|${cat}` : `${acct}|${cat}|${rec.id}`;
      if (!groups.has(key)) groups.set(key, { acct, cat, items: [] });
      groups.get(key).items.push({ rec, payees: catPayees });
    }
  }

  const ordered = [...groups.entries()]
    .sort((a, b) => a[1].acct.localeCompare(b[1].acct)
      || PAY_CAT_ORDER.indexOf(a[1].cat) - PAY_CAT_ORDER.indexOf(b[1].cat)
      || a[0].localeCompare(b[0]));

  const vouchers = [];
  for (const [, g] of ordered) {
    const { acct, cat, items } = g;
    const v = {
      year: ctx.year, kind: '2', importrecno: ctx.nextRecno(),
      mvchno: ctx.mvchno || '', payDate: ctx.payDate7, postDate: ctx.postDate7 || ctx.payDate7,
      memo: '', rnum: 0, urgent: '', scode1: '1',
      lines: [], payees: [], sourceIds: items.map((it) => it.rec.id),
      acctCode: acct, acctName: (ctx.acctNames && ctx.acctNames[acct]) || acct,
      payCat: cat, payCatLabel: PAY_CAT_LABEL[cat] || cat,
    };
    let seq = 1, total = 0;
    /* 銀行專戶列（先佔位，金額最後補） */
    const bankLine = { seq: seq++, dc: 'C', code: acct, use: '', relate: '',
      scode1: '00001' /* 歸屬性質：本基金代碼檔=00001.一般（官方範例的 55000 與本基金不符，實測 v5.3.1） */, bcode: ctx.bcodeFor(acct), amt: 0, ttype: '2', memo: '' };
    v.lines.push(bankLine);

    const memoParts = [];
    for (const { rec, payees } of items) {
      /* 本張傳票承擔的金額＝本類別受款人金額合計（一單跨類別時自動拆分） */
      const catAmt = Math.round(payees.reduce((s, p) => s + (+p.amt || 0), 0) * 100) / 100;
      const recAmt = Math.round((+rec.total || 0) * 100) / 100;
      total += catAmt;
      memoParts.push(String(rec.purposeDesc || rec.bpLabel || '').trim());
      const base = {
        dc: 'D', code: rec.bpCode, use: useOf(rec), relate: relateOf(rec),
        scode1: '00001' /* 歸屬性質：本基金代碼檔=00001.一般（官方範例的 55000 與本基金不符，實測 v5.3.1） */, bcode: ctx.bcodeFor(rec.bpCode), ttype: '2',
      };
      if (base.use && /^1\d{3}$/.test(base.use)) base.pkind = ctx.defaultPkind || '';
      /* purposeSplits 多用途 → 每拆分一列（僅本張承擔整單金額時才展開） */
      const splits = Array.isArray(rec.purposeSplits)
        ? rec.purposeSplits.filter((s) => s && +s.amt > 0) : [];
      if (splits.length > 1 && catAmt === recAmt) {
        const ssum = Math.round(splits.reduce((s, x) => s + (+x.amt || 0), 0) * 100) / 100;
        if (ssum !== recAmt)
          issues.push({ recId: rec.id, level: 'warn', msg: `${rec.voucherNo}：用途拆分合計 ${ssum} ≠ 單金額 ${recAmt}，請於預覽調整` });
        for (const sp of splits) {
          v.lines.push({ ...base, seq: seq++, amt: +sp.amt || 0,
            memo: `${sp.name}｜${String(rec.purposeDesc || '').trim()}` });
        }
      } else {
        if (splits.length > 1)
          issues.push({ recId: rec.id, level: 'warn',
            msg: `${rec.voucherNo}：多用途拆分因跨付款方式而併為單列，用途明細請於預覽摘要確認` });
        const memoTxt = (rec.bpCode === '21020301' && rec.purposeName)
          ? `${rec.purposeName}｜${String(rec.purposeDesc || '').trim()}`
          : String(rec.purposeDesc || '').trim();
        v.lines.push({ ...base, seq: seq++, amt: catAmt, memo: memoTxt });
      }
      v.payees.push(...payees);
    }
    bankLine.amt = Math.round(total * 100) / 100;
    /* 摘要不帶「類別｜」前綴（使用者指定；類別已在預覽卡頭標示） */
    bankLine.memo = truncBig5(memoParts.filter(Boolean).join('；'), 1000);
    v.memo = memoParts.filter(Boolean).join('；');   /* 不先截斷：validateVoucher 才警告得到過長，F03 寫檔時再 truncBig5(100) */
    /* 使用者規則：自領/代繳整張只掛一個受款人「交由佳里區農會代繳」，金額＝傳票總額，不管來源幾筆 */
    if (cat === '2') {
      v.payees = [{ seq: 1, name: '交由佳里區農會代繳', account: '', userbank: '', bankna: '',
        payway: '2', amt: Math.round(total * 100) / 100,
        remark1: '0', remark2: '1', /* 自領/代繳：劃線否、禁背是（使用者規則） */
        usedoc: truncBig5(memoParts.filter(Boolean).join('；'), 1000), rev: '0',
        srcType: 'bill-agg', srcRec: '', needsInput: false }];
    }
    v.payees.forEach((p, i) => { p.seq = i + 1; });
    vouchers.push(v);
  }
  return { vouchers, issues };
}

/* ── Node 測試支援 ── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SBA_CORE_VERSION,
    rocDate7, toRoc7, big5Len, truncBig5, xmlEscape, fmt2, fmt6, buildXml,
    F03_FIELDS, F04_FIELDS, F05_FIELDS, F06_FIELDS, F07_FIELDS,
    validateVoucher, validateBatch, guessBcode, FIXED_ASSET_CODES,
    splitBank, decidePayway, mapRecordsToVouchers,
    FNWACX_SHEET, FNWACX_FUND, FNWACX_HEADERS, payeeToFnwacxRow, buildSbaPayeeIndex, payeeExistsInSba, normPayeeName,
    unzipAll, buildFnwacxFromTemplate, isValidGui, roc7DiffDays,
    resolvePayees, planGrouping, PAY_CAT_LABEL, PAY_CAT_ORDER,
    voucherToF03Row, voucherToF04Rows, voucherToF05Rows, voucherToF06Rows, voucherToF07Rows,
    buildExportFiles, crc32, buildZip,
  };
}

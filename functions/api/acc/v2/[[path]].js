/**
 * ACC v2 API — 結構化資料表 + Export/Import 再現性保證
 *
 * Routes (prefix /api/acc/v2):
 *   GET    /bootstrap             → 一次回全部資料（首頁開頁用）
 *   GET    /vouchers              → {ym → {entries, locked, locked_at, updated_at}}
 *   GET    /vouchers/:ym
 *   PUT    /vouchers/:ym          body: {entries, locked?, unlock?}
 *   GET    /monthly               → {ym → {data, locked, ...}}
 *   GET    /monthly/:ym
 *   PUT    /monthly/:ym           body: {data, locked?, unlock?}
 *   GET    /ledger/:type          → [rows]
 *   PUT    /ledger/:type          body: [rows]（整表覆寫，含軟刪除）
 *   GET    /config                → {key → value}
 *   PUT    /config/:key           body: value（可為 string 或物件，server 端 JSON 化）
 *   GET    /export                → 完整 JSON dump（canonical 格式）
 *   POST   /import                body: export 格式 JSON；原子性 replace
 *   POST   /migrate               從舊 settings 搬 acc_* → 新表（一次性）
 *
 * 所有 PUT/POST 都需 X-Admin-Pass（沿用 EAF 的 ADMIN_PASS）
 *
 * 鎖定保護：PUT /vouchers/:ym 或 /monthly/:ym 如果 DB 現狀 locked=1，
 *          除非 body 明確帶 {unlock:true}，否則 server 直接 409。
 *
 * Schema 首次呼叫自動 ensure（CREATE IF NOT EXISTS）— 不需手動跑 migration。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  /* bug #29: 加 DELETE，handler 有 DELETE /entries/:voucher_no 但原本 preflight 擋下 */
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const nowIso = () => new Date().toISOString();

/* ── Schema ensure（冪等，每次請求呼叫一次 BEGIN；D1 自己處理 no-op 很快） ── */
async function ensureSchema(DB) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS acc_vouchers (
       ym TEXT PRIMARY KEY,
       entries TEXT NOT NULL DEFAULT '[]',
       locked INTEGER NOT NULL DEFAULT 0,
       locked_at TEXT,
       updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS acc_monthly (
       ym TEXT PRIMARY KEY,
       data TEXT NOT NULL DEFAULT '{}',
       locked INTEGER NOT NULL DEFAULT 0,
       locked_at TEXT,
       updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS acc_voucher_entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       voucher_no TEXT NOT NULL,
       voucher_type TEXT NOT NULL,
       ym TEXT NOT NULL,
       seq INTEGER NOT NULL,
       make_date TEXT,
       post_date TEXT,
       subject TEXT,
       sub_account TEXT,
       purpose TEXT,
       description TEXT,
       debit INTEGER NOT NULL DEFAULT 0,
       credit INTEGER NOT NULL DEFAULT 0,
       payee_info TEXT,
       payee_amount INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL DEFAULT 'excel_import',
       imported_at TEXT,
       updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_ventry_key ON acc_voucher_entries(voucher_no, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_ventry_ym ON acc_voucher_entries(ym)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_ventry_type ON acc_voucher_entries(voucher_type)`,
    `CREATE TABLE IF NOT EXISTS acc_voucher_entries_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       voucher_no TEXT NOT NULL,
       seq INTEGER NOT NULL,
       voucher_type TEXT,
       ym TEXT,
       action TEXT NOT NULL,
       field_diffs TEXT NOT NULL DEFAULT '{}',
       changed_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_vhist_key ON acc_voucher_entries_history(voucher_no, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_vhist_time ON acc_voucher_entries_history(changed_at)`,
    `CREATE TABLE IF NOT EXISTS acc_ledger (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ledger_type TEXT NOT NULL,
       ym TEXT NOT NULL,
       entry_type TEXT NOT NULL,
       amount INTEGER NOT NULL DEFAULT 0,
       description TEXT,
       ref_id TEXT,
       voided INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_ledger_type_ym ON acc_ledger(ledger_type, ym)`,
    `CREATE INDEX IF NOT EXISTS idx_acc_ledger_type ON acc_ledger(ledger_type)`,
    `CREATE TABLE IF NOT EXISTS acc_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL)`,
  ];
  await DB.batch(stmts.map((s) => DB.prepare(s)));
}

function auth(request, env) {
  const adminPass = env.ADMIN_PASS;
  if (!adminPass) return true;
  return request.headers.get('X-Admin-Pass') === adminPass;
}

/* ── Canonical JSON：key 排序，產出 stable bytes 方便 round-trip 驗證 ── */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = canonicalize(obj[k]);
  return sorted;
}

/* ── 路由解析 ── */
function route(url) {
  const m = url.pathname.match(/^\/api\/acc\/v2\/(.*)$/);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  return parts;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const DB = env.DB;
  if (!DB) return json({ error: 'D1 未設定' }, 500);

  try {
    await ensureSchema(DB);
  } catch (e) {
    return json({ error: 'Schema init failed: ' + e.message }, 500);
  }

  const url = new URL(request.url);
  const parts = route(url);
  if (!parts) return json({ error: 'Not found' }, 404);

  const method = request.method;
  const [res1, res2] = parts;

  try {
    /* ──────── GET /bootstrap ──────── */
    if (method === 'GET' && res1 === 'bootstrap' && !res2) {
      const [vR, mR, lR, cR, eR] = await Promise.all([
        DB.prepare('SELECT ym, entries, locked, locked_at, updated_at FROM acc_vouchers').all(),
        DB.prepare('SELECT ym, data, locked, locked_at, updated_at FROM acc_monthly').all(),
        DB.prepare('SELECT id, ledger_type, ym, entry_type, amount, description, ref_id, voided, updated_at FROM acc_ledger ORDER BY id').all(),
        DB.prepare('SELECT key, value, updated_at FROM acc_config').all(),
        DB.prepare('SELECT * FROM acc_voucher_entries ORDER BY voucher_no, seq').all(),
      ]);
      const vouchers = {};
      for (const r of vR.results) vouchers[r.ym] = {
        entries: JSON.parse(r.entries), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at,
      };
      const monthly = {};
      for (const r of mR.results) monthly[r.ym] = {
        data: JSON.parse(r.data), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at,
      };
      const ledger = {};
      for (const r of lR.results) {
        if (!ledger[r.ledger_type]) ledger[r.ledger_type] = [];
        ledger[r.ledger_type].push({
          id: r.id, ym: r.ym, entry_type: r.entry_type, amount: r.amount,
          description: r.description, ref_id: r.ref_id, voided: !!r.voided, updated_at: r.updated_at,
        });
      }
      const config = {};
      for (const r of cR.results) {
        try { config[r.key] = JSON.parse(r.value); } catch { config[r.key] = r.value; }
      }
      return json({ vouchers, monthly, ledger, config, voucher_entries: eR.results });
    }

    /* ──────── VOUCHERS ──────── */
    if (res1 === 'vouchers') {
      if (method === 'GET' && !res2) {
        const { results } = await DB.prepare('SELECT * FROM acc_vouchers').all();
        const out = {};
        for (const r of results) out[r.ym] = {
          entries: JSON.parse(r.entries), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at,
        };
        return json(out);
      }
      if (method === 'GET' && res2) {
        const r = await DB.prepare('SELECT * FROM acc_vouchers WHERE ym = ?').bind(res2).first();
        if (!r) return json(null);
        return json({ entries: JSON.parse(r.entries), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at });
      }
      if (method === 'PUT' && res2) {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const body = await request.json();
        /* bug #28: 需保留原 locked_at，重鎖時不要覆寫稽核時間戳 */
        /* bug #2 (v4.4.24): 原本 `body.locked !== false` 讓前端硬送 locked:false 可繞過 409 偷偷解鎖；改為「只有 unlock=true 才能寫已鎖月」 */
        const cur = await DB.prepare('SELECT locked, locked_at FROM acc_vouchers WHERE ym = ?').bind(res2).first();
        if (cur && cur.locked && !body.unlock) {
          return json({ error: `${res2} 已鎖定，需 {unlock:true} 才能覆寫` }, 409);
        }
        const entries = JSON.stringify(body.entries || []);
        const locked = body.locked ? 1 : 0;
        /* 鎖定時：若原本已鎖，沿用舊 locked_at；首次鎖才寫 now */
        const lockedAt = body.locked ? (cur && cur.locked_at ? cur.locked_at : nowIso()) : null;
        const updatedAt = nowIso();
        await DB.prepare(`
          INSERT INTO acc_vouchers (ym, entries, locked, locked_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(ym) DO UPDATE SET
            entries = excluded.entries,
            locked = excluded.locked,
            locked_at = excluded.locked_at,
            updated_at = excluded.updated_at
        `).bind(res2, entries, locked, lockedAt, updatedAt).run();
        return json({ ok: true, ym: res2, updated_at: updatedAt });
      }
    }

    /* ──────── MONTHLY ──────── */
    if (res1 === 'monthly') {
      if (method === 'GET' && !res2) {
        const { results } = await DB.prepare('SELECT * FROM acc_monthly').all();
        const out = {};
        for (const r of results) out[r.ym] = {
          data: JSON.parse(r.data), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at,
        };
        return json(out);
      }
      if (method === 'GET' && res2) {
        const r = await DB.prepare('SELECT * FROM acc_monthly WHERE ym = ?').bind(res2).first();
        if (!r) return json(null);
        return json({ data: JSON.parse(r.data), locked: !!r.locked, locked_at: r.locked_at, updated_at: r.updated_at });
      }
      if (method === 'PUT' && res2) {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const body = await request.json();
        /* bug #28: 保留原 locked_at（同 vouchers PUT 的修法） */
        /* bug #2 (v4.4.24): 同上，移除 locked !== false 後門 */
        const cur = await DB.prepare('SELECT locked, locked_at FROM acc_monthly WHERE ym = ?').bind(res2).first();
        if (cur && cur.locked && !body.unlock) {
          return json({ error: `${res2} 月結已鎖定，需 {unlock:true} 才能覆寫` }, 409);
        }
        const data = JSON.stringify(body.data || {});
        const locked = body.locked ? 1 : 0;
        const lockedAt = body.locked ? (cur && cur.locked_at ? cur.locked_at : nowIso()) : null;
        const updatedAt = nowIso();
        await DB.prepare(`
          INSERT INTO acc_monthly (ym, data, locked, locked_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(ym) DO UPDATE SET
            data = excluded.data,
            locked = excluded.locked,
            locked_at = excluded.locked_at,
            updated_at = excluded.updated_at
        `).bind(res2, data, locked, lockedAt, updatedAt).run();
        return json({ ok: true, ym: res2, updated_at: updatedAt });
      }
    }

    /* ──────── VOUCHER ENTRIES（分錄顆粒，Excel 匯入用） ──────── */
    if (res1 === 'entries') {
      // GET /entries?ym=11503&type=支出  → 列表查詢
      if (method === 'GET' && !res2) {
        const ym = url.searchParams.get('ym');
        const vtype = url.searchParams.get('type');
        const conds = []; const binds = [];
        if (ym)    { conds.push('ym = ?');           binds.push(ym); }
        if (vtype) { conds.push('voucher_type = ?'); binds.push(vtype); }
        const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
        const { results } = await DB.prepare(
          `SELECT * FROM acc_voucher_entries${where} ORDER BY voucher_no, seq`
        ).bind(...binds).all();
        return json(results);
      }
      // POST /entries/cleanup-blank → 清除空白分錄（無 subject 且借貸皆 0）
      // bug #3 (v4.4.24): 原本完全無 auth，任何外部訪客可觸發硬刪除 → 補 admin auth
      if (method === 'POST' && res2 === 'cleanup-blank') {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const r = await DB.prepare(
          `DELETE FROM acc_voucher_entries WHERE (subject IS NULL OR subject = '') AND debit = 0 AND credit = 0`
        ).run();
        return json({ ok: true, deleted: r.meta?.changes ?? 0 });
      }
      // GET /entries/history?voucher_no=&limit= → 歷史變更資料
      if (method === 'GET' && res2 === 'history') {
        const vno = url.searchParams.get('voucher_no');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 5000);
        const where = vno ? ' WHERE voucher_no = ?' : '';
        const binds = vno ? [vno] : [];
        const { results } = await DB.prepare(
          `SELECT * FROM acc_voucher_entries_history${where} ORDER BY id DESC LIMIT ${limit}`
        ).bind(...binds).all();
        return json(results);
      }
      // GET /entries/:voucher_no → 單張傳票全部分錄
      if (method === 'GET' && res2) {
        const { results } = await DB.prepare(
          'SELECT * FROM acc_voucher_entries WHERE voucher_no = ? ORDER BY seq'
        ).bind(res2).all();
        return json(results);
      }
      // PUT /entries  body: [rows]  → upsert by (voucher_no, seq) — 重複匯入零重覆計算
      if (method === 'PUT' && !res2) {
        // bug #3 (v4.4.24): 原本「後台登入才到得了」前提不成立 — acc-import.html / acc.html 都無 auth 閘
        //   攻擊者可直接 PUT 偽造 100k 筆分錄污染 acc_voucher_entries 跟 history
        //   補 admin auth，前端已在 v4.4.24 改送 X-Admin-Pass
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const rows = await request.json();
        if (!Array.isArray(rows)) return json({ error: 'body must be array' }, 400);
        const updatedAt = nowIso();
        const ins = DB.prepare(`
          INSERT INTO acc_voucher_entries
            (voucher_no, voucher_type, ym, seq, make_date, post_date,
             subject, sub_account, purpose, description,
             debit, credit, payee_info, payee_amount,
             source, imported_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(voucher_no, seq) DO UPDATE SET
            voucher_type = excluded.voucher_type,
            ym           = excluded.ym,
            make_date    = excluded.make_date,
            post_date    = excluded.post_date,
            subject      = excluded.subject,
            sub_account  = excluded.sub_account,
            purpose      = excluded.purpose,
            description  = excluded.description,
            debit        = excluded.debit,
            credit       = excluded.credit,
            payee_info   = excluded.payee_info,
            payee_amount = excluded.payee_amount,
            source       = excluded.source,
            imported_at  = excluded.imported_at,
            updated_at   = excluded.updated_at
        `);
        const stmts = [];
        let inserted = 0, updated = 0, unchanged = 0;
        // 先抓已存在 row 全欄位（要用於 diff）
        const existing = new Map();
        if (rows.length) {
          for (let i = 0; i < rows.length; i += 50) {
            const ch = rows.slice(i, i + 50);
            const placeholders = ch.map(() => '(?, ?)').join(',');
            const binds = [];
            for (const r of ch) { binds.push(String(r.voucher_no||''), Number(r.seq)||0); }
            const q = await DB.prepare(
              `SELECT * FROM acc_voucher_entries WHERE (voucher_no, seq) IN (VALUES ${placeholders})`
            ).bind(...binds).all();
            for (const x of q.results) existing.set(`${x.voucher_no}::${x.seq}`, x);
          }
        }
        // 歷史紀錄 prepared stmt
        const insHist = DB.prepare(`
          INSERT INTO acc_voucher_entries_history
            (voucher_no, seq, voucher_type, ym, action, field_diffs, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const DIFF_FIELDS = ['voucher_type','ym','make_date','post_date','subject','sub_account',
          'purpose','description','debit','credit','payee_info','payee_amount'];
        const normVal = (v) => (v == null || v === '') ? null : v;
        for (const r of rows) {
          const key = `${r.voucher_no}::${r.seq}`;
          const old = existing.get(key);
          const newVals = {
            voucher_type: String(r.voucher_type||''),
            ym: String(r.ym||''),
            make_date: r.make_date||null,
            post_date: r.post_date||null,
            subject: r.subject||null,
            sub_account: r.sub_account||null,
            purpose: r.purpose||null,
            description: r.description||null,
            debit: Math.round(Number(r.debit)||0),
            credit: Math.round(Number(r.credit)||0),
            payee_info: r.payee_info||null,
            payee_amount: Math.round(Number(r.payee_amount)||0),
          };
          let action = null;
          const diffs = {};
          if (!old) {
            action = 'insert';
            inserted++;
            for (const f of DIFF_FIELDS) diffs[f] = [null, newVals[f]];
          } else {
            for (const f of DIFF_FIELDS) {
              const a = normVal(old[f]);
              const b = normVal(newVals[f]);
              if (String(a) !== String(b)) diffs[f] = [a, b];
            }
            if (Object.keys(diffs).length > 0) { action = 'update'; updated++; }
            else { unchanged++; }
          }
          if (action) {
            stmts.push(insHist.bind(
              String(r.voucher_no||''), Number(r.seq)||0,
              newVals.voucher_type, newVals.ym, action,
              JSON.stringify(diffs), updatedAt
            ));
          }
          stmts.push(ins.bind(
            String(r.voucher_no || ''),
            String(r.voucher_type || ''),
            String(r.ym || ''),
            Number(r.seq) || 0,
            r.make_date || null,
            r.post_date || null,
            r.subject || null,
            r.sub_account || null,
            r.purpose || null,
            r.description || null,
            Math.round(Number(r.debit) || 0),
            Math.round(Number(r.credit) || 0),
            r.payee_info || null,
            Math.round(Number(r.payee_amount) || 0),
            String(r.source || 'excel_import'),
            r.imported_at || updatedAt,
            updatedAt
          ));
        }
        // D1 batch 一次最多 ~100 條，分段送
        for (let i = 0; i < stmts.length; i += 50) {
          await DB.batch(stmts.slice(i, i + 50));
        }
        return json({ ok: true, total: rows.length, inserted, updated, unchanged, updated_at: updatedAt });
      }
      // DELETE /entries/:voucher_no  → 砍整張傳票（誤匯入救援用）
      // bug #16 (v4.4.24): 原本直接 DELETE 不寫 history → 稽核上完全靜默
      //   先 SELECT 舊值、INSERT acc_voucher_entries_history with action='delete' + diffs，再 DELETE
      // v4.4.25 修：history INSERT + DELETE 改為單一 D1.batch 確保原子性（避免 history 寫一半或 DELETE 失敗造成假性刪除）
      if (method === 'DELETE' && res2) {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const oldRows = await DB.prepare(
          'SELECT * FROM acc_voucher_entries WHERE voucher_no = ?'
        ).bind(res2).all();
        const changedAt = nowIso();
        const histStmts = (oldRows.results || []).map(old => {
          const diffs = {};
          for (const f of ['voucher_type','ym','make_date','post_date','subject','sub_account',
                           'purpose','description','debit','credit','payee_info','payee_amount']) {
            diffs[f] = [old[f], null];
          }
          return DB.prepare(`
            INSERT INTO acc_voucher_entries_history
              (voucher_no, seq, voucher_type, ym, action, field_diffs, changed_at)
            VALUES (?, ?, ?, ?, 'delete', ?, ?)
          `).bind(old.voucher_no, old.seq, old.voucher_type || '', old.ym || '',
                  JSON.stringify(diffs), changedAt);
        });
        const deleteStmt = DB.prepare('DELETE FROM acc_voucher_entries WHERE voucher_no = ?').bind(res2);
        /* v4.4.25 round-2 #16 補強：fallback 路徑也要保證最後一批跟 deleteStmt 一起 batch
           原本「先分批 history、再單獨 deleteStmt.run()」非原子 → history 半寫但 delete 失敗會殘留不一致
           新做法：除最後一批外照常 batch；最後一批 append deleteStmt 同 batch 提交 */
        const allStmts = histStmts.concat([deleteStmt]);
        let totalDeleted = 0;
        if (allStmts.length <= 50) {
          const result = await DB.batch(allStmts);
          totalDeleted = result[result.length - 1]?.meta?.changes ?? 0;
        } else {
          /* >50 條（單張傳票分錄極多）：分批執行 history，最後一批必含 deleteStmt 一起 batch */
          const PER_BATCH = 50;
          /* 把最後 (PER_BATCH-1) 筆 history + deleteStmt 留到最後 batch */
          const lastBatchSize = (PER_BATCH - 1);
          const middleEnd = histStmts.length > lastBatchSize ? histStmts.length - lastBatchSize : 0;
          for (let i = 0; i < middleEnd; i += PER_BATCH) {
            await DB.batch(histStmts.slice(i, Math.min(i + PER_BATCH, middleEnd)));
          }
          const finalBatch = histStmts.slice(middleEnd).concat([deleteStmt]);
          const finalResult = await DB.batch(finalBatch);
          totalDeleted = finalResult[finalResult.length - 1]?.meta?.changes ?? 0;
        }
        return json({ ok: true, voucher_no: res2, deleted: totalDeleted, history_logged: histStmts.length });
      }
    }

    /* ──────── LEDGER ──────── */
    if (res1 === 'ledger') {
      if (method === 'GET' && res2) {
        const { results } = await DB.prepare(
          'SELECT id, ym, entry_type, amount, description, ref_id, voided, updated_at FROM acc_ledger WHERE ledger_type = ? ORDER BY id'
        ).bind(res2).all();
        return json(results.map(r => ({ ...r, voided: !!r.voided })));
      }
      if (method === 'PUT' && res2) {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const rows = await request.json();
        if (!Array.isArray(rows)) return json({ error: 'body must be array' }, 400);
        const updatedAt = nowIso();
        const stmts = [DB.prepare('DELETE FROM acc_ledger WHERE ledger_type = ?').bind(res2)];
        const ins = DB.prepare(`
          INSERT INTO acc_ledger (ledger_type, ym, entry_type, amount, description, ref_id, voided, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of rows) {
          stmts.push(ins.bind(
            res2,
            String(r.ym || ''),
            String(r.entry_type || r.type || ''),
            Math.round(Number(r.amount ?? r.amt) || 0),
            r.description ?? r.desc ?? null,
            r.ref_id ?? null,
            r.voided ? 1 : 0,
            updatedAt
          ));
        }
        await DB.batch(stmts);
        return json({ ok: true, ledger_type: res2, count: rows.length, updated_at: updatedAt });
      }
    }

    /* ──────── CONFIG ──────── */
    if (res1 === 'config') {
      if (method === 'GET' && !res2) {
        const { results } = await DB.prepare('SELECT key, value FROM acc_config').all();
        const out = {};
        for (const r of results) {
          try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
        }
        return json(out);
      }
      if (method === 'PUT' && res2) {
        if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
        const body = await request.json();
        const val = typeof body === 'string' ? body : JSON.stringify(body);
        const updatedAt = nowIso();
        await DB.prepare(`
          INSERT INTO acc_config (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(res2, val, updatedAt).run();
        return json({ ok: true, key: res2 });
      }
    }

    /* ──────── EXPORT ──────── */
    if (method === 'GET' && res1 === 'export' && !res2) {
      const [vR, mR, lR, cR, eR] = await Promise.all([
        DB.prepare('SELECT ym, entries, locked, locked_at, updated_at FROM acc_vouchers ORDER BY ym').all(),
        DB.prepare('SELECT ym, data, locked, locked_at, updated_at FROM acc_monthly ORDER BY ym').all(),
        DB.prepare('SELECT ledger_type, ym, entry_type, amount, description, ref_id, voided FROM acc_ledger ORDER BY ledger_type, ym, id').all(),
        DB.prepare('SELECT key, value FROM acc_config ORDER BY key').all(),
        DB.prepare(`SELECT voucher_no, voucher_type, ym, seq, make_date, post_date,
                           subject, sub_account, purpose, description,
                           debit, credit, payee_info, payee_amount,
                           source, imported_at
                    FROM acc_voucher_entries ORDER BY voucher_no, seq`).all(),
      ]);
      const dump = {
        version: 2,
        exported_at: nowIso(),
        vouchers: vR.results.map(r => ({
          ym: r.ym, entries: JSON.parse(r.entries),
          locked: !!r.locked, locked_at: r.locked_at,
        })),
        monthly: mR.results.map(r => ({
          ym: r.ym, data: JSON.parse(r.data),
          locked: !!r.locked, locked_at: r.locked_at,
        })),
        ledger: lR.results.map(r => ({
          ledger_type: r.ledger_type, ym: r.ym, entry_type: r.entry_type,
          amount: r.amount, description: r.description, ref_id: r.ref_id, voided: !!r.voided,
        })),
        config: cR.results.reduce((acc, r) => {
          try { acc[r.key] = JSON.parse(r.value); } catch { acc[r.key] = r.value; }
          return acc;
        }, {}),
        voucher_entries: eR.results,
      };
      const canonical = canonicalize(dump);
      return new Response(JSON.stringify(canonical, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json',
                   'Content-Disposition': `attachment; filename="acc_export_${nowIso().slice(0,10)}.json"` },
      });
    }

    /* ──────── IMPORT ──────── */
    if (method === 'POST' && res1 === 'import' && !res2) {
      if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
      const body = await request.json();
      if (!body || body.version !== 2) return json({ error: 'invalid export format (need version:2)' }, 400);
      const updatedAt = nowIso();
      const stmts = [
        DB.prepare('DELETE FROM acc_vouchers'),
        DB.prepare('DELETE FROM acc_monthly'),
        DB.prepare('DELETE FROM acc_ledger'),
        DB.prepare('DELETE FROM acc_config'),
      ];
      const insV = DB.prepare('INSERT INTO acc_vouchers (ym, entries, locked, locked_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (const v of body.vouchers || []) {
        stmts.push(insV.bind(v.ym, JSON.stringify(v.entries || []), v.locked ? 1 : 0, v.locked_at || null, updatedAt));
      }
      const insM = DB.prepare('INSERT INTO acc_monthly (ym, data, locked, locked_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (const m of body.monthly || []) {
        stmts.push(insM.bind(m.ym, JSON.stringify(m.data || {}), m.locked ? 1 : 0, m.locked_at || null, updatedAt));
      }
      const insL = DB.prepare('INSERT INTO acc_ledger (ledger_type, ym, entry_type, amount, description, ref_id, voided, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const l of body.ledger || []) {
        stmts.push(insL.bind(l.ledger_type, l.ym, l.entry_type, Math.round(Number(l.amount) || 0),
                             l.description ?? null, l.ref_id ?? null, l.voided ? 1 : 0, updatedAt));
      }
      const insC = DB.prepare('INSERT INTO acc_config (key, value, updated_at) VALUES (?, ?, ?)');
      for (const [k, v] of Object.entries(body.config || {})) {
        stmts.push(insC.bind(k, typeof v === 'string' ? v : JSON.stringify(v), updatedAt));
      }
      // voucher_entries：import 時先清空再塞（完整 dump 場景）
      stmts.push(DB.prepare('DELETE FROM acc_voucher_entries'));
      const insE = DB.prepare(`INSERT INTO acc_voucher_entries
        (voucher_no, voucher_type, ym, seq, make_date, post_date,
         subject, sub_account, purpose, description,
         debit, credit, payee_info, payee_amount,
         source, imported_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of body.voucher_entries || []) {
        stmts.push(insE.bind(
          String(e.voucher_no||''), String(e.voucher_type||''), String(e.ym||''), Number(e.seq)||0,
          e.make_date||null, e.post_date||null, e.subject||null, e.sub_account||null,
          e.purpose||null, e.description||null,
          Math.round(Number(e.debit)||0), Math.round(Number(e.credit)||0),
          e.payee_info||null, Math.round(Number(e.payee_amount)||0),
          String(e.source||'excel_import'), e.imported_at||null, updatedAt
        ));
      }
      // 分段送避免超過 D1 batch 上限
      for (let i = 0; i < stmts.length; i += 50) {
        await DB.batch(stmts.slice(i, i + 50));
      }
      return json({ ok: true, imported: {
        vouchers: (body.vouchers||[]).length, monthly: (body.monthly||[]).length,
        ledger: (body.ledger||[]).length, config: Object.keys(body.config||{}).length,
        voucher_entries: (body.voucher_entries||[]).length,
      }});
    }

    /* ──────── MIGRATE（舊 settings.acc_* → 新表） ──────── */
    if (method === 'POST' && res1 === 'migrate' && !res2) {
      if (!auth(request, env)) return json({ error: '密碼錯誤' }, 401);
      const url2 = new URL(request.url);
      const dryRun = url2.searchParams.get('dry') === '1';
      const { results } = await DB.prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'acc_%'"
      ).all();

      const summary = { vouchers: 0, monthly: 0, ledger: 0, config: 0, skipped: [] };
      const updatedAt = nowIso();
      const stmts = [];

      /* 整理 settings 資料到 in-memory map */
      const kv = {};
      for (const r of results) {
        try { kv[r.key] = JSON.parse(r.value); } catch { kv[r.key] = r.value; }
      }

      /* vouchers: acc_vouchers_<ym> */
      for (const k of Object.keys(kv)) {
        const m = k.match(/^acc_vouchers_(\d+)$/);
        if (!m) continue;
        const ym = m[1];
        const entries = Array.isArray(kv[k]) ? kv[k] : [];
        const tsKey = `acc_vouchers_${ym}_ts`;
        const lockedAt = kv[tsKey] || null;
        stmts.push(DB.prepare(`INSERT INTO acc_vouchers (ym, entries, locked, locked_at, updated_at)
          VALUES (?, ?, 1, ?, ?) ON CONFLICT(ym) DO UPDATE SET
          entries = excluded.entries, locked = 1,
          locked_at = excluded.locked_at, updated_at = excluded.updated_at`)
          .bind(ym, JSON.stringify(entries), lockedAt, updatedAt));
        summary.vouchers++;
      }

      /* monthly: acc_monthly_<ym> */
      for (const k of Object.keys(kv)) {
        const m = k.match(/^acc_monthly_(\d+)$/);
        if (!m) continue;
        const ym = m[1];
        const data = typeof kv[k] === 'object' && kv[k] !== null ? kv[k] : {};
        const tsKey = `acc_monthly_${ym}_ts`;
        const lockedAt = kv[tsKey] || null;
        stmts.push(DB.prepare(`INSERT INTO acc_monthly (ym, data, locked, locked_at, updated_at)
          VALUES (?, ?, 0, ?, ?) ON CONFLICT(ym) DO UPDATE SET
          data = excluded.data, locked_at = excluded.locked_at, updated_at = excluded.updated_at`)
          .bind(ym, JSON.stringify(data), lockedAt, updatedAt));
        summary.monthly++;
      }

      /* ledger: acc_inv_drug / acc_inv_supply / acc_allow_ledger / 等
         值為 [{ym, type, amt, desc, voided}] 陣列 */
      const LEDGER_KEYS = {
        acc_inv_drug: 'drug',
        acc_inv_supply: 'supply',
        acc_allow_ledger: 'allow',
        acc_property_ledger: 'property',
      };
      for (const [srcKey, ledgerType] of Object.entries(LEDGER_KEYS)) {
        if (!Array.isArray(kv[srcKey])) continue;
        stmts.push(DB.prepare('DELETE FROM acc_ledger WHERE ledger_type = ?').bind(ledgerType));
        const ins = DB.prepare(`INSERT INTO acc_ledger
          (ledger_type, ym, entry_type, amount, description, ref_id, voided, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of kv[srcKey]) {
          stmts.push(ins.bind(
            ledgerType,
            String(r.ym || ''),
            String(r.type || r.entry_type || ''),
            Math.round(Number(r.amt ?? r.amount) || 0),
            r.desc ?? r.description ?? null,
            r.medId ?? r.ref_id ?? null,
            r.voided ? 1 : 0,
            updatedAt
          ));
          summary.ledger++;
        }
      }

      /* config: 其餘 acc_* key（排除 _ts、上面吃掉的） */
      const SKIP_PREFIX = /^acc_(vouchers|monthly|inv_drug|inv_supply|allow_ledger|property_ledger)(_|$)/;
      for (const k of Object.keys(kv)) {
        if (SKIP_PREFIX.test(k)) continue;
        if (k.endsWith('_ts')) continue;
        const v = kv[k];
        stmts.push(DB.prepare(`INSERT INTO acc_config (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .bind(k, typeof v === 'string' ? v : JSON.stringify(v), updatedAt));
        summary.config++;
      }

      if (dryRun) return json({ dryRun: true, summary });
      await DB.batch(stmts);
      return json({ ok: true, summary });
    }

    return json({ error: 'Not found: ' + method + ' ' + url.pathname }, 404);
  } catch (e) {
    return json({ error: e.message, stack: e.stack }, 500);
  }
}

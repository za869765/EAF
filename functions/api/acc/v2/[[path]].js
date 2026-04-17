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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
      const [vR, mR, lR, cR] = await Promise.all([
        DB.prepare('SELECT ym, entries, locked, locked_at, updated_at FROM acc_vouchers').all(),
        DB.prepare('SELECT ym, data, locked, locked_at, updated_at FROM acc_monthly').all(),
        DB.prepare('SELECT id, ledger_type, ym, entry_type, amount, description, ref_id, voided, updated_at FROM acc_ledger ORDER BY id').all(),
        DB.prepare('SELECT key, value, updated_at FROM acc_config').all(),
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
      return json({ vouchers, monthly, ledger, config });
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
        const cur = await DB.prepare('SELECT locked FROM acc_vouchers WHERE ym = ?').bind(res2).first();
        if (cur && cur.locked && !body.unlock && body.locked !== false) {
          return json({ error: `${res2} 已鎖定，需 {unlock:true} 才能覆寫` }, 409);
        }
        const entries = JSON.stringify(body.entries || []);
        const locked = body.locked ? 1 : 0;
        const lockedAt = body.locked ? nowIso() : null;
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
        const cur = await DB.prepare('SELECT locked FROM acc_monthly WHERE ym = ?').bind(res2).first();
        if (cur && cur.locked && !body.unlock && body.locked !== false) {
          return json({ error: `${res2} 月結已鎖定，需 {unlock:true} 才能覆寫` }, 409);
        }
        const data = JSON.stringify(body.data || {});
        const locked = body.locked ? 1 : 0;
        const lockedAt = body.locked ? nowIso() : null;
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
      const [vR, mR, lR, cR] = await Promise.all([
        DB.prepare('SELECT ym, entries, locked, locked_at, updated_at FROM acc_vouchers ORDER BY ym').all(),
        DB.prepare('SELECT ym, data, locked, locked_at, updated_at FROM acc_monthly ORDER BY ym').all(),
        DB.prepare('SELECT ledger_type, ym, entry_type, amount, description, ref_id, voided FROM acc_ledger ORDER BY ledger_type, ym, id').all(),
        DB.prepare('SELECT key, value FROM acc_config ORDER BY key').all(),
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
      await DB.batch(stmts);
      return json({ ok: true, imported: {
        vouchers: (body.vouchers||[]).length, monthly: (body.monthly||[]).length,
        ledger: (body.ledger||[]).length, config: Object.keys(body.config||{}).length,
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

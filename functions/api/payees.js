/**
 * /api/payees  — 受款人清單（存 D1 settings 表，key='payees'）
 *
 *   GET  /api/payees               → 公開讀取
 *   POST /api/payees               → 整包覆寫（需 X-Admin-Pass）
 *   PATCH /api/payees              → 單筆新增/更新（body: { name, acctNo, bank, ... }）
 *   DELETE /api/payees?key=xxx     → 依 key 刪除（key 格式: name||acctNo||bank）
 *
 * payees JSON shape (array of):
 *   { name, acctNo, bank, lastTransferDate?, createdAt?, isNew?: bool }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

function payeeKey(p) {
  return `${p.name||''}||${p.acctNo||''}||${p.bank||''}`;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const DB = env.DB;
  if (!DB) return json({ error: 'D1 未設定' }, 500);

  const url = new URL(request.url);

  /* ── GET ── */
  if (request.method === 'GET') {
    try {
      const row = await DB.prepare("SELECT value FROM settings WHERE key = 'payees'").first();
      if (!row) return json([]);
      return json(JSON.parse(row.value));
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* 以下寫入操作皆需管理密碼 */
  const adminPass = env.ADMIN_PASS;
  const providedPass = request.headers.get('X-Admin-Pass');
  if (!adminPass || providedPass !== adminPass) {
    return json({ error: '密碼錯誤' }, 401);
  }

  /* ── POST：整包覆寫 ── */
  if (request.method === 'POST') {
    try {
      const payees = await request.json();
      if (!Array.isArray(payees)) return json({ error: '須為陣列' }, 400);
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('payees', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify(payees)).run();
      return json({ ok: true, count: payees.length });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  /* ── PATCH：單筆 upsert（name+acctNo+bank 為 key） ── */
  if (request.method === 'PATCH') {
    try {
      const incoming = await request.json();
      if (!incoming || !incoming.name) return json({ error: 'missing name' }, 400);
      const row = await DB.prepare("SELECT value FROM settings WHERE key='payees'").first();
      const list = row ? JSON.parse(row.value) : [];
      const k = payeeKey(incoming);
      const idx = list.findIndex(p => payeeKey(p) === k);
      if (idx >= 0) list[idx] = { ...list[idx], ...incoming };
      else list.push({ ...incoming, createdAt: incoming.createdAt || new Date().toISOString().slice(0,10), isNew: true });
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('payees', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify(list)).run();
      return json({ ok: true, count: list.length });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  /* ── DELETE：依 key 刪除 ── */
  if (request.method === 'DELETE') {
    try {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'missing key' }, 400);
      const row = await DB.prepare("SELECT value FROM settings WHERE key='payees'").first();
      if (!row) return json({ ok: true, count: 0 });
      const list = JSON.parse(row.value).filter(p => payeeKey(p) !== key);
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('payees', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify(list)).run();
      return json({ ok: true, count: list.length });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return new Response('Method Not Allowed', { status: 405, headers: CORS });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/**
 * /api/employees — 員工 / 員工代墊 名單（存 D1 settings 表，key='employee_list'）
 *
 *   GET  /api/employees   → 公開讀取，回傳姓名字串陣列（未建檔回 []）
 *   POST /api/employees   → 整包覆寫（需 X-Admin-Pass），body 須為字串陣列
 *
 * v4.6.8：原本員工名單寫死在 index.html 的 EMPLOYEE_LIST，改存 D1 供 admin 編輯；
 *         index.html 仍保留同一份 14 人作為「D1 尚未建檔」時的離線後備。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const DB = env.DB;
  if (!DB) return json({ error: 'D1 未設定' }, 500);

  /* ── GET：公開讀取 ── */
  if (request.method === 'GET') {
    try {
      const row = await DB.prepare("SELECT value FROM settings WHERE key = 'employee_list'").first();
      if (!row) return json([]);
      return json(JSON.parse(row.value));
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* ── POST：整包覆寫（需管理密碼） ── */
  if (request.method === 'POST') {
    const adminPass = env.ADMIN_PASS;
    const providedPass = request.headers.get('X-Admin-Pass');
    if (!adminPass || providedPass !== adminPass) return json({ error: '密碼錯誤' }, 401);
    try {
      const raw = await request.json();
      if (!Array.isArray(raw)) return json({ error: '須為陣列' }, 400);
      /* 正規化：去頭尾空白、濾掉空字串、去重（保留順序） */
      const seen = new Set();
      const names = raw.map(n => String(n || '').trim())
                       .filter(n => n && !seen.has(n) && seen.add(n));
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('employee_list', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify(names)).run();
      return json({ ok: true, count: names.length });
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

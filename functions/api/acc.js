/**
 * 醫療基金帳務資料 — D1 settings 表讀寫
 *
 * GET  /api/acc          → 讀取全部 acc_* 設定（回傳 {key:value,...}）
 * GET  /api/acc?key=xxx  → 讀取單一 key
 * POST /api/acc          → 儲存單一或多筆 {key, value} 或 [{key,value},...]
 *                          需要 X-Admin-Pass header
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const DB = env.DB;
  if (!DB) return json({ error: 'D1 未設定' }, 500);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  /* ── GET ── */
  if (request.method === 'GET') {
    try {
      if (key) {
        const row = await DB.prepare(
          'SELECT value FROM settings WHERE key = ?'
        ).bind(key).first();
        return json(row ? JSON.parse(row.value) : null);
      }
      /* 讀取全部 acc_* */
      const { results } = await DB.prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'acc_%'"
      ).all();
      const out = {};
      for (const r of results) {
        try { out[r.key] = JSON.parse(r.value); } catch (_) { out[r.key] = r.value; }
      }
      return json(out);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* ── POST（需管理者密碼） ── */
  if (request.method === 'POST') {
    const adminPass = env.ADMIN_PASS;
    if (adminPass && request.headers.get('X-Admin-Pass') !== adminPass) {
      return json({ error: '密碼錯誤' }, 401);
    }
    try {
      const body = await request.json();
      const items = Array.isArray(body) ? body : [body];
      const stmt = DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      await DB.batch(items.map(({ key: k, value: v }) =>
        stmt.bind(k, typeof v === 'string' ? v : JSON.stringify(v))
      ));
      return json({ ok: true, saved: items.length });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}

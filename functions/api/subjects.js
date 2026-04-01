/**
 * GET  /api/subjects          → 讀取科目設定（公開）
 * POST /api/subjects          → 更新科目設定（需管理密碼）
 *   Header: X-Admin-Pass: yourpassword
 *
 * 科目設定儲存於 D1 的 settings 資料表（key = 'subjects'）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const DB = env.DB;
  if (!DB) return json(null, 404); /* D1 未設定時讓前端 fallback 到靜態 subjects.json */

  /* ── GET ── */
  if (request.method === 'GET') {
    try {
      const row = await DB.prepare(
        "SELECT value FROM settings WHERE key = 'subjects'"
      ).first();
      if (!row) return json(null, 404);
      return json(JSON.parse(row.value));
    } catch (_) {
      return json(null, 404);
    }
  }

  /* ── POST（管理者） ── */
  if (request.method === 'POST') {
    const adminPass = env.ADMIN_PASS;
    if (!adminPass || request.headers.get('X-Admin-Pass') !== adminPass) {
      return json({ error: '密碼錯誤' }, 401);
    }
    try {
      const subjects = await request.json();
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('subjects', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify(subjects)).run();
      return json({ ok: true });
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

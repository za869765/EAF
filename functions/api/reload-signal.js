/**
 * /api/reload-signal — 強制重整廣播訊號（存 D1 settings 表，key='reload_signal'）
 *
 *   GET  /api/reload-signal   → 公開讀取，回 { ts: <毫秒時戳> }（未建檔回 { ts: 0 }）
 *   POST /api/reload-signal   → 更新訊號為當下時間（需 X-Admin-Pass），回 { ok, ts }
 *
 * v5.0.2：admin 解鎖/還原單據後發訊號；index 填單頁輪詢到「訊號時間 > 頁面載入時間」
 *         即比照新版本偵測跳出強制重整彈窗（避免有人停在過期的編輯畫面操作）。
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
      const row = await DB.prepare("SELECT value FROM settings WHERE key = 'reload_signal'").first();
      if (!row) return json({ ts: 0 });
      return json(JSON.parse(row.value));
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* ── POST：發訊號（需管理密碼） ── */
  if (request.method === 'POST') {
    const adminPass = env.ADMIN_PASS;
    const providedPass = request.headers.get('X-Admin-Pass');
    if (!adminPass || providedPass !== adminPass) return json({ error: '密碼錯誤' }, 401);
    try {
      const ts = Date.now();
      await DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('reload_signal', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(JSON.stringify({ ts })).run();
      return json({ ok: true, ts });
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

/**
 * Cloudflare Pages Function — 在線人數追蹤
 *
 * D1 table: presence (id TEXT PK, last_seen TEXT)
 *   自動建表（首次呼叫時）
 *
 * API：
 *   POST /api/presence         → 心跳（body: { sid })
 *   GET  /api/presence         → 回傳 5 分鐘內活躍人數
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function ensureTable(DB) {
  try {
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS presence (
        sid TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL
      )
    `).run();
  } catch (_) { /* table already exists */ }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const DB = env.DB;
  if (!DB) return json({ error: 'no DB' }, 500);

  await ensureTable(DB);

  const cutoff = new Date(Date.now() - TIMEOUT_MS).toISOString();

  /* ── POST：心跳 ── */
  if (request.method === 'POST') {
    try {
      const { sid } = await request.json();
      if (!sid) return json({ error: 'missing sid' }, 400);

      await DB.prepare(`
        INSERT INTO presence (sid, last_seen) VALUES (?, ?)
        ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen
      `).bind(sid, new Date().toISOString()).run();

      /* 清理過期紀錄 */
      await DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(cutoff).run();

      const { results } = await DB.prepare(
        'SELECT COUNT(*) as cnt FROM presence WHERE last_seen >= ?'
      ).bind(cutoff).all();

      /* 讀取維護模式旗標 */
      let maintenance = false;
      try {
        const sRow = await DB.prepare("SELECT value FROM settings WHERE key = 'subjects'").first();
        if (sRow) {
          const sData = JSON.parse(sRow.value);
          maintenance = !!sData?.settings?.maintenance;
        }
      } catch (_) {}

      return json({ ok: true, online: results[0].cnt, maintenance });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* ── GET：查詢在線人數 ── */
  if (request.method === 'GET') {
    try {
      const { results } = await DB.prepare(
        'SELECT COUNT(*) as cnt FROM presence WHERE last_seen >= ?'
      ).bind(cutoff).all();
      return json({ online: results[0].cnt });
    } catch (e) {
      return json({ error: e.message }, 500);
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

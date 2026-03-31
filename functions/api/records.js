/**
 * Cloudflare Pages Function：GitHub Gist 代理
 *
 * 環境變數（在 Cloudflare Pages → Settings → Environment variables 設定）：
 *   GIST_ID    ← Gist 的 ID（網址最後一段）
 *   GIST_TOKEN ← GitHub Personal Access Token（gist 權限）
 *
 * API：
 *   GET  /api/records       → 讀取所有紀錄
 *   POST /api/records       → 儲存紀錄（body: JSON array）
 */

const GIST_FILE = 'records.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const gistId = env.GIST_ID;
  const token  = env.GIST_TOKEN;

  // 尚未設定環境變數
  if (!gistId || !token) {
    return json({ error: '尚未設定 GIST_ID / GIST_TOKEN 環境變數' }, 500);
  }

  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'EAF-CloudflareWorker/1.0',
  };

  /* ── GET：讀取紀錄 ── */
  if (request.method === 'GET') {
    try {
      const res  = await fetch(`https://api.github.com/gists/${gistId}`, { headers: ghHeaders });
      if (!res.ok) return json([], 200);
      const data    = await res.json();
      const content = data.files?.[GIST_FILE]?.content || '[]';
      return json(JSON.parse(content), 200);
    } catch (_) {
      return json([], 200);
    }
  }

  /* ── POST：儲存紀錄 ── */
  if (request.method === 'POST') {
    try {
      const records = await request.json();
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: ghHeaders,
        body: JSON.stringify({
          files: { [GIST_FILE]: { content: JSON.stringify(records, null, 2) } }
        }),
      });
      return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502);
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

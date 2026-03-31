/**
 * GET  /api/subjects          → 讀取科目設定（公開）
 * POST /api/subjects          → 更新科目設定（需管理密碼）
 *   Header: X-Admin-Pass: yourpassword
 *
 * 科目設定儲存於 Gist 的 subjects.json 檔案中
 */

const GIST_FILE = 'subjects.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const gistId = env.GIST_ID;
  const token  = env.GIST_TOKEN;
  if (!gistId || !token) return json({ error: '尚未設定環境變數' }, 500);

  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'EAF-Worker/1.0',
  };

  /* ── GET ── */
  if (request.method === 'GET') {
    try {
      const res  = await fetch(`https://api.github.com/gists/${gistId}`, { headers: ghHeaders });
      if (!res.ok) return json(null, 404);
      const data    = await res.json();
      const content = data.files?.[GIST_FILE]?.content;
      if (!content) return json(null, 404);  /* 告知前端改用靜態檔 */
      return json(JSON.parse(content), 200);
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
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: ghHeaders,
        body: JSON.stringify({
          files: { [GIST_FILE]: { content: JSON.stringify(subjects, null, 2) } }
        }),
      });
      return json({ ok: res.ok }, res.ok ? 200 : 502);
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

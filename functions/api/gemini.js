/* POST /api/gemini — 傳票摘要 AI 潤飾中繼（需 X-Admin-Pass）
   環境變數：GEMINI_API_KEY（使用者的 Gemini 付費 key，於 Pages 專案設定）
   請求：{ items: [{ id, text }] } → 回應：{ items: [{ id, text }] }（潤飾後） */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};
export async function onRequestOptions() { return new Response(null, { headers: CORS }); }
export async function onRequestPost({ request, env }) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  if (!env.ADMIN_PASS || request.headers.get('X-Admin-Pass') !== env.ADMIN_PASS)
    return json({ error: 'unauthorized' }, 401);
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY 未設定（Pages 專案 → 設定 → 環境變數）' }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 30) : [];
  if (!items.length) return json({ error: 'no items' }, 400);
  const prompt = '你是台灣公家機關（衛生所醫療作業基金）會計。以下是支出傳票的摘要草稿（由多張動支/請購單摘要串接而成，可能過長、贅字、被截斷）。'
    + '請將每一則改寫為通順、精簡、保留關鍵資訊（用途、月份、金額可省略）的繁體中文傳票摘要，長度以 50 個中文字內為原則。'
    + '不可捏造內容，只能整理原文。回覆 JSON 陣列，格式 [{"id":"...","text":"..."}]，不要其他文字。\n\n'
    + JSON.stringify(items);
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + env.GEMINI_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });
  if (!r.ok) return json({ error: 'Gemini ' + r.status + '：' + (await r.text()).slice(0, 300) }, 502);
  const data = await r.json();
  const txt = (((data.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || '').join('');
  let out;
  try { out = JSON.parse(txt); } catch (_) { return json({ error: 'AI 回覆非 JSON：' + txt.slice(0, 200) }, 502); }
  if (!Array.isArray(out)) return json({ error: 'AI 回覆格式不符' }, 502);
  return json({ items: out.filter((x) => x && x.id != null && typeof x.text === 'string') });
}

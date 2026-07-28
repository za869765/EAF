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
  const prompt = '你是台灣佳里區衛生所醫療作業基金的會計。以下是支出傳票摘要草稿（由多張動支/請購單摘要串接，常過長、有公文贅詞、可能被截斷）。'
    + '請依本所「開票習慣」改寫每一則為精簡繁中傳票摘要，長度以 50 字內為原則：\n'
    + '1. 年月用縮寫：「115.7」或「11507」或「115年7月」；去掉「擬支付/擬支/支原定/檢附○○各1份」等公文贅詞。\n'
    + '2. 格式偏好「用途-對象-明細」，如「115.01藥品費-裕利-冠脂妥等三件(919+1139=2058)」。\n'
    + '3. 多筆合併以頓號或&分項；有金額計算式時保留「(a+b=c)」。\n'
    + '4. 代墊註記保留，如「(由職王聖捷代墊)」。\n'
    + '本所實際範例：「11501影印機租金(19/48)」「114.12醫療廢棄物清理費」「115年第一季台灣星堡保全費」'
    + '「11501中華電信市話寬頻費&公務手機&VPN月租(4544+998+1691=7233)」「114年12月門診醫生應診費」「流感疫苗接種加班費」。\n'
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

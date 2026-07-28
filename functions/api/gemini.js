/* POST /api/gemini — 傳票摘要 AI 潤飾中繼（需 X-Admin-Pass）
   環境變數：GEMINI_API_KEY（使用者的 Gemini 付費 key，於 Pages 專案設定）
   請求：{ items: [{ id, main, lines: [{ seq, text, amt }], payees: [{ seq, text, amt }] }] }
   回應：{ items: [{ id, memo, lines: [{ seq, text }], payees: [{ seq, text }] }] }
   規則：memo=主檔摘要概括不含金額；lines/payees text=「對象+費用+金額」（千分位+元） */
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
  const prompt = '你是台灣佳里區衛生所醫療作業基金的會計。以下每張支出傳票有「主檔摘要草稿 main」與「明細列 lines（text=摘要草稿、amt=該列明細金額）」，草稿常過長、有公文贅詞。請依本所開票習慣改寫：\n'
    + '【memo 傳票主檔摘要】「不得出現任何金額數字」，但必須把本張各明細的費用大類別逐一點到（頓號串接），'
    + '如「115.7行動醫院郵資、印刷費、誤餐費、搬運費、桌椅租用、檯燈、濾心、代檢費、角鋼架等費用」；'
    + '以 45 個中文字為上限（SBA 欄位限制），類別太多時保留主要者並以「等」收斂，不可只寫籠統的「雜項支出」。\n'
    + '【lines[].text 明細摘要】核心格式＝「對象（公司/廠商/人）＋什麼費用＋多少錢」，其餘一律省略；'
    + '每列文字必須含該列 amt 的金額且與 amt 完全一致，金額一律千分位加「元」（1039→1,039元）。'
    + '若該列金額由多個品項組成，「必須」逐項詳列品項與各自金額並寫出加總式（如「市話寬頻4,544元+公務手機998元+健保VPN1,691元=7,233元」），不可只寫總額或省略品項。\n'
    + '【payees[].text 受款人支出用途】極簡一句：「年月＋什麼的什麼費用＋金額」，如「115.7中華電信電信費9,090元」「115.6尚捷檢驗費4,705元」；金額與該受款人 amt 一致（千分位+元）。\n'
    + '共同規則：繁體中文；年月縮寫（115.7／11507／115年7月）；'
    + '「擬支付」「擬支」「支付」「支原定」等開頭字眼一律刪除；「檢附○○（印領清冊／課程表／領據／簽到單…）各1份」之類的檢附句整句刪除；'
    + '「1. 2. 3.」條列編號刪除；代墊註記保留（如「(由職王聖捷代墊)」）；不可捏造內容，只能整理原文。\n'
    + '回覆 JSON 陣列，格式 [{"id":"...","memo":"...","lines":[{"seq":1,"text":"..."}],"payees":[{"seq":1,"text":"..."}]}]，不要其他文字。\n\n'
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
  return json({ items: out.filter((x) => x && x.id != null) });
}

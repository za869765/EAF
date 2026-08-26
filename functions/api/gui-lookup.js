/* GET /api/gui-lookup?no=12345678 — 統編→官方登記名稱（v5.9.4）
   來源：①經濟部 GCIS 公司登記公示（公司組織）②g0v 台灣公司資料 API（涵蓋商業登記行號/營業登記）
   查無回 {name:null}；純查詢無需密碼；邊緣快取一天（登記名稱極少變動） */
const CORS = { 'Access-Control-Allow-Origin': '*' };
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const no = String(url.searchParams.get('no') || '').trim();
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', ...CORS } });
  if (!/^\d{8}$/.test(no)) return json({ error: 'bad no' }, 400);
  const tryFetch = async (u, pick) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } });
      clearTimeout(t);
      if (!r.ok) return '';
      return pick(await r.json()) || '';
    } catch (_) { return ''; }
  };
  let name = await tryFetch(
    'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?$format=json&$filter=Business_Accounting_NO%20eq%20' + no + '&$skip=0&$top=1',
    (d) => Array.isArray(d) && d[0] && d[0].Company_Name);
  let source = name ? 'gcis' : '';
  if (!name) {
    name = await tryFetch('https://company.g0v.ronny.tw/api/show/' + no, (d) => {
      const x = (d && d.data) || {};
      let n = x['公司名稱'] || x['商業名稱'] || x['名稱'] || x['營業人名稱'] || '';
      if (Array.isArray(n)) n = n[0] || '';
      return typeof n === 'string' ? n.trim() : '';
    });
    if (name) source = 'g0v';
  }
  return json({ no, name: String(name || '').trim() || null, source });
}

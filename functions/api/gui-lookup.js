/* GET /api/gui-lookup?no=12345678 — 統編→官方登記名稱（v5.9.4）
   來源：①經濟部 GCIS 公司登記公示（公司組織）②g0v 台灣公司資料 API（涵蓋商業登記行號/營業登記）
   查無回 {name:null}；純查詢無需密碼；邊緣快取一天（登記名稱極少變動） */
const CORS = { 'Access-Control-Allow-Origin': '*' };
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const no = String(url.searchParams.get('no') || '').trim();
  const json = (obj, status, ttl) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + (ttl != null ? ttl : 86400), ...CORS } });
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
      /* v5.9.5 財政部「營業人名稱」優先（=F07 欄位語意；分公司統編唯此欄有全名，如
         53668663→全聯實業股份有限公司佳里中山分公司），再退公司/商業名稱、分公司名稱 */
      const fia = x['財政部'] || {};
      let n = fia['營業人名稱'] || x['公司名稱'] || x['商業名稱'] || x['名稱'] || x['營業人名稱'] || x['分公司名稱'] || '';
      if (Array.isArray(n)) n = n[0] || '';
      return typeof n === 'string' ? n.trim() : '';
    });
    if (name) source = 'g0v';
  }
  /* 查無僅短快取（來源暫時失敗/新登記者 5 分鐘後可再查）；查到快取一天 */
  return json({ no, name: String(name || '').trim() || null, source }, 200, name ? 86400 : 300);
}

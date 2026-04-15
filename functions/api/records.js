/**
 * Cloudflare Pages Function — D1 資料庫代理
 *
 * 環境變數：
 *   DB  ← D1 binding（在 wrangler.toml 或 Cloudflare Pages 設定）
 *
 * API：
 *   GET    /api/records           → 讀取所有紀錄（陣列）
 *   POST   /api/records           → 新增或更新單筆紀錄（body: 單筆 JSON）
 *   PATCH  /api/records?id=xxx    → 部分更新欄位（body: 任意可覆寫欄位；id/savedAt 受保護）
 *   DELETE /api/records?id=xxx    → 永久刪除單筆
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const DB = env.DB;
  if (!DB) return json({ error: '尚未設定 D1 資料庫 binding' }, 500);

  const url = new URL(request.url);
  const id  = url.searchParams.get('id');

  /* ── GET：讀取紀錄（預設排除已封存；?all=1 含封存） ── */
  if (request.method === 'GET') {
    /* v4.2.17 取下一個可用的憑證編號：掃全部紀錄（含封存/作廢），避免封存後同號重複 */
    if (url.searchParams.get('next-voucher') === '1') {
      try {
        const year = url.searchParams.get('year') || String(new Date().getFullYear() - 1911);
        const { results } = await DB.prepare(
          'SELECT voucher_no FROM records WHERE voucher_no LIKE ?'
        ).bind(year + '-%').all();
        let max = 0;
        for (const r of results) {
          const parts = (r.voucher_no || '').split('-');
          const n = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n) && n > max) max = n;
        }
        const next = year + '-' + String(max + 1).padStart(4, '0');
        return json({ year, max, next });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    try {
      const all = url.searchParams.get('all') === '1';
      const sql = all
        ? 'SELECT data FROM records ORDER BY saved_at DESC'
        : "SELECT data FROM records WHERE COALESCE(json_extract(data,'$.archived'),0)!=1 ORDER BY saved_at DESC";
      const { results } = await DB.prepare(sql).all();
      const records = results.reduce((acc, row) => {
        try { acc.push(JSON.parse(row.data)); } catch (_) { /* skip malformed */ }
        return acc;
      }, []);
      return json(records);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  /* ── POST：新增或更新單筆 ── */
  if (request.method === 'POST') {
    try {
      const record = await request.json();
      if (!record.id) return json({ ok: false, error: 'missing id' }, 400);

      /* v4.2.17 憑證編號重複防呆：檢查 voucher_no 是否已被「其他 id」使用（掃全部含封存/作廢） */
      if (record.voucherNo) {
        const dup = await DB.prepare(
          'SELECT id FROM records WHERE voucher_no = ? AND id != ? LIMIT 1'
        ).bind(record.voucherNo, record.id).first();
        if (dup) {
          return json({ ok: false, error: `憑證編號 ${record.voucherNo} 已被其他紀錄使用（id=${dup.id}）`, code: 'DUP_VOUCHER_NO' }, 409);
        }
      }

      await DB.prepare(`
        INSERT INTO records (id, voucher_no, form_type, voided, saved_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          voucher_no = excluded.voucher_no,
          form_type  = excluded.form_type,
          voided     = excluded.voided,
          saved_at   = excluded.saved_at,
          data       = excluded.data
      `).bind(
        record.id,
        record.voucherNo || '',
        record.formType  || '',
        record.voided ? 1 : 0,
        record.savedAt   || '',
        JSON.stringify(record)
      ).run();

      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  /* ── PATCH：部分更新（作廢旗標 / 管理者編輯內容） ── */
  if (request.method === 'PATCH') {
    if (!id) return json({ ok: false, error: 'missing id' }, 400);
    try {
      const patch = await request.json();
      const row = await DB.prepare(
        'SELECT data FROM records WHERE id = ?'
      ).bind(id).first();
      if (!row) return json({ ok: false, error: 'not found' }, 404);

      const rec = JSON.parse(row.data);
      /* 保護不允許被覆寫的欄位 */
      const PROTECTED = new Set(['id', 'savedAt']);
      Object.entries(patch).forEach(([k, v]) => {
        if (!PROTECTED.has(k)) rec[k] = v;
      });
      /* v4.2.17 若 PATCH 改到 voucherNo，先驗證不與其他 id 重複 */
      if (patch.voucherNo && patch.voucherNo !== (JSON.parse(row.data).voucherNo || '')) {
        const dup = await DB.prepare(
          'SELECT id FROM records WHERE voucher_no = ? AND id != ? LIMIT 1'
        ).bind(patch.voucherNo, id).first();
        if (dup) {
          return json({ ok: false, error: `憑證編號 ${patch.voucherNo} 已被其他紀錄使用（id=${dup.id}）`, code: 'DUP_VOUCHER_NO' }, 409);
        }
      }
      const voidedBit = rec.voided ? 1 : 0;
      /* v4.2.17 同步更新 voucher_no 欄位（原本只更新 data 欄，導致 voucher_no 資料與 JSON 失同步） */
      await DB.prepare(
        'UPDATE records SET voided = ?, voucher_no = ?, data = ? WHERE id = ?'
      ).bind(voidedBit, rec.voucherNo || '', JSON.stringify(rec), id).run();

      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  /* ── DELETE：永久刪除 ── */
  if (request.method === 'DELETE') {
    if (!id) return json({ ok: false, error: 'missing id' }, 400);
    try {
      await DB.prepare('DELETE FROM records WHERE id = ?').bind(id).run();
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

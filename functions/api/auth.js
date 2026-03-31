/**
 * POST /api/auth  → { ok: true/false }
 * Body: { "password": "xxx" }
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { password } = await request.json();
    const ok = !!(env.ADMIN_PASS && password === env.ADMIN_PASS);
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (_) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

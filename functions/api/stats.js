import { validSession } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const results = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(
        CASE
          WHEN status NOT IN ('cancelled', 'returned')
          THEN subtotal
          ELSE 0
        END
      ) AS revenue
    FROM orders
  `).first();

  return new Response(JSON.stringify({
    total: Number(results?.total || 0),
    new: Number(results?.new || 0),
    confirmed: Number(results?.confirmed || 0),
    delivered: Number(results?.delivered || 0),
    revenue: Number(results?.revenue || 0)
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

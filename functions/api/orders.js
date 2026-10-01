import { validSession } from '../_lib/auth.js';
import { priceFor } from '../_lib/products.js';

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function newId() {
  return 'SK-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  // Customer data sent by the current index.html
  const c = body.customer || {};

  const name = String(c.name || '').trim();
  const phone = String(c.phone || '').replace(/[\s-]/g, '');
  const address = String(c.address || '').trim();
  const city = String(c.city || '').trim();

  const payment = String(body.payment || 'Cash on Delivery');

  if (!name || !/^03\d{9}$/.test(phone) || !address || !city) {
    return json({
      ok: false,
      error: 'Missing required customer information'
    }, 400);
  }

  if (payment !== 'Cash on Delivery') {
    return json({
      ok: false,
      error: 'Only Cash on Delivery is enabled.'
    }, 400);
  }

  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > 20
  ) {
    return json({
      ok: false,
      error: 'Your bag is empty or invalid.'
    }, 400);
  }

  const items = [];
  let subtotal = 0;

  for (const raw of body.items) {
    const nameKey = String(raw.name || '');
    const price = priceFor(nameKey);
    const qty = Number(raw.qty);

    if (
      price === null ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 99
    ) {
      return json({
        ok: false,
        error: 'Invalid product or quantity.'
      }, 400);
    }

    const lineTotal = price * qty;

    items.push({
      name: nameKey,
      qty,
      price,
      lineTotal
    });

    subtotal += lineTotal;
  }

  const id = newId();
  const createdAt = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO orders (
      id,
      created_at,
      customer_name,
      customer_phone,
      customer_address,
      customer_city,
      payment_method,
      items_json,
      subtotal,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      id,
      createdAt,
      name,
      phone,
      address,
      city,
      payment,
      JSON.stringify(items),
      subtotal,
      'new'
    )
    .run();

  return json({
    ok: true,
    orderId: id,
    total: subtotal,
    createdAt
  });
}

export async function onRequestGet({ request, env }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return json({
      ok: false,
      error: 'Unauthorized.'
    }, 401);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');

  let sql = `
    SELECT
      id,
      created_at,
      customer_name,
      customer_phone,
      customer_address,
      customer_city,
      payment_method,
      items_json,
      subtotal,
      status,
      notes
    FROM orders
  `;

  const clauses = [];
  const args = [];

  if (status && status !== 'all') {
    clauses.push('status = ?');
    args.push(status);
  }

  if (q) {
    clauses.push(
      '(id LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR customer_city LIKE ?)'
    );

    const x = `%${q}%`;
    args.push(x, x, x, x);
  }

  if (clauses.length) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC LIMIT 200';

  const result = await env.DB
    .prepare(sql)
    .bind(...args)
    .all();

  const orders = (result.results || []).map(o => ({
    ...o,
    items: JSON.parse(o.items_json)
  }));

  return json({
    ok: true,
    orders
  });
}

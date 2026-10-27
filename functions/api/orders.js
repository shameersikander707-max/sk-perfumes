
import { validSession } from '../_lib/auth.js';

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

function newId() {
  return 'SK-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Application-level checkout throttle. Store only a SHA-256 hash of the
// Cloudflare-provided client IP, not the raw IP address.
const CHECKOUT_LIMIT = 5;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

async function hashClientIp(ip) {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function checkCheckoutRateLimit(request, env) {
  // CF-Connecting-IP is set by Cloudflare at the edge; do not trust a
  // client-supplied X-Forwarded-For header as a substitute.
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!clientIp) return { ok: false, unavailable: true };

  const now = Date.now();
  const windowStart = Math.floor(now / CHECKOUT_WINDOW_MS) * CHECKOUT_WINDOW_MS;
  const ipHash = await hashClientIp(clientIp);

  try {
    const row = await env.DB.prepare(`
      INSERT INTO checkout_rate_limits (ip_hash, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(ip_hash) DO UPDATE SET
        request_count = CASE
          WHEN checkout_rate_limits.window_start = excluded.window_start
            THEN checkout_rate_limits.request_count + 1
          ELSE 1
        END,
        window_start = excluded.window_start
      RETURNING request_count
    `).bind(ipHash, windowStart).first();

    // Opportunistically remove stale counters. This table holds one row per
    // recently seen IP hash, not one row per request.
    await env.DB.prepare(`
      DELETE FROM checkout_rate_limits WHERE window_start < ?
    `).bind(windowStart - RATE_LIMIT_RETENTION_MS).run();

    const count = Number(row?.request_count);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + CHECKOUT_WINDOW_MS - Date.now()) / 1000));
    return { ok: Number.isInteger(count) && count <= CHECKOUT_LIMIT, retryAfterSeconds };
  } catch {
    // Fail closed if rate limiting cannot be checked; don't accept orders
    // without the configured abuse control.
    return { ok: false, unavailable: true };
  }
}

export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  const c = body.customer || {};
  const name = String(c.name || '').trim();
  const phone = String(c.phone || '').replace(/[\s-]/g, '');
  const address = String(c.address || '').trim();
  const city = String(c.city || '').trim();
  const payment = String(body.payment || 'Cash on Delivery');

  if (!name || !/^03\d{9}$/.test(phone) || !address || !city) {
    return json({
      ok: false,
      error: 'Please provide a valid name, Pakistani mobile number, address and city.'
    }, 400);
  }

  if (payment !== 'Cash on Delivery') {
    return json({
      ok: false,
      error: 'Only Cash on Delivery is enabled.'
    }, 400);
  }

  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) {
    return json({ ok: false, error: 'Your bag is empty or invalid.' }, 400);
  }

  // Combine duplicate product lines to prevent quantity-limit bypasses.
  const quantities = new Map();

  for (const raw of body.items) {
    const productName = String(raw?.name || '');
    const qty = Number(raw?.qty);

    if (
      !productName ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 99
    ) {
      return json({ ok: false, error: 'Invalid product or quantity.' }, 400);
    }

    quantities.set(productName, (quantities.get(productName) || 0) + qty);

    if (quantities.get(productName) > 99) {
      return json({ ok: false, error: 'Maximum quantity per product is 99.' }, 400);
    }
  }

  // Count only requests that passed basic payload validation, but throttle
  // before product lookup, stock reservation, and order creation.
  const rateLimit = await checkCheckoutRateLimit(request, env);
  if (rateLimit.unavailable) {
    return json({
      ok: false,
      error: 'Checkout is temporarily unavailable. Please try again shortly.'
    }, 503);
  }
  if (!rateLimit.ok) {
    return json({
      ok: false,
      error: 'Too many checkout attempts from this connection. Please wait a few minutes and try again.',
      retryAfterSeconds: rateLimit.retryAfterSeconds
    }, 429, { 'Retry-After': String(rateLimit.retryAfterSeconds) });
  }

  const names = [...quantities.keys()];
  const placeholders = names.map(() => '?').join(',');

  let lookup;

  try {
    lookup = await env.DB.prepare(`
      SELECT id, name, price, stock, active
      FROM products
      WHERE name IN (${placeholders})
    `).bind(...names).all();
  } catch {
    return json({ ok: false, error: 'Unable to verify product availability.' }, 500);
  }

  const productByName = new Map(
    (lookup.results || []).map(p => [p.name, p])
  );

  const items = [];
  const reservationProducts = [];
  let subtotal = 0;

  for (const productName of names) {
    const product = productByName.get(productName);
    const qty = quantities.get(productName);

    if (!product || product.active !== 1) {
      return json({
        ok: false,
        error: `${productName} is unavailable. Please refresh your bag.`
      }, 409);
    }

    if (product.stock < qty) {
      return json({
        ok: false,
        error: `Only ${product.stock} unit(s) of ${productName} are currently available. Please update your bag.`
      }, 409);
    }

    const lineTotal = product.price * qty;
    subtotal += lineTotal;

    items.push({
      name: product.name,
      qty,
      price: product.price,
      lineTotal
    });

    reservationProducts.push({
      id: product.id,
      name: product.name,
      qty
    });
  }

  const id = newId();
  const createdAt = new Date().toISOString();

  // D1 batch runs these statements as a transaction.
  // The database trigger aborts the batch if concurrent orders
  // would make stock negative or try to change inactive-product stock.
  const statements = [
    env.DB.prepare(`
      INSERT INTO orders (
        id, created_at, customer_name, customer_phone,
        customer_address, customer_city, payment_method,
        items_json, subtotal, status, inventory_state
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'reserved')
    `).bind(
      id,
      createdAt,
      name,
      phone,
      address,
      city,
      payment,
      JSON.stringify(items),
      subtotal
    )
  ];

  for (const product of reservationProducts) {
    statements.push(
      env.DB.prepare(`
        UPDATE products
        SET stock = stock - ?
        WHERE id = ?
      `).bind(product.qty, product.id)
    );

    statements.push(
      env.DB.prepare(`
        INSERT INTO inventory_movements (
          product_id, order_id, movement_type, quantity, note
        )
        VALUES (?, ?, 'reserve', ?, ?)
      `).bind(
        product.id,
        id,
        product.qty,
        `Stock reserved for order ${id}`
      )
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = String(error?.message || '');

    if (
      message.includes('Insufficient stock') ||
      message.toLowerCase().includes('constraint')
    ) {
      return json({
        ok: false,
        error: 'Stock changed while you were ordering. Please refresh your bag and try again.'
      }, 409);
    }

    return json({
      ok: false,
      error: 'We could not save your order. Please try again.'
    }, 500);
  }

  return json({
    ok: true,
    orderId: id,
    total: subtotal,
    createdAt
  });
}

export async function onRequestGet({ request, env }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');

  let sql = `
    SELECT
      id, created_at, customer_name, customer_phone,
      customer_address, customer_city, payment_method,
      items_json, subtotal, status, notes, inventory_state
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

  try {
    const result = await env.DB.prepare(sql).bind(...args).all();

    const orders = (result.results || []).map(o => ({
      ...o,
      items: JSON.parse(o.items_json)
    }));

    return json({ ok: true, orders });
  } catch {
    return json({ ok: false, error: 'Unable to load orders.' }, 500);
  }
}

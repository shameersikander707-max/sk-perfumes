import { validSession } from '../_lib/auth.js';
import { getProductPrice } from '../_lib/products.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    const {
      customer_name,
      customer_phone,
      customer_address,
      customer_city,
      payment_method,
      items
    } = body;

    if (!customer_name || !customer_phone || !customer_address || !customer_city) {
      return new Response(
        JSON.stringify({ error: 'Missing required customer information' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    if (!/^03\d{9}$/.test(customer_phone)) {
      return new Response(
        JSON.stringify({ error: 'Invalid Pakistani mobile number' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    if (payment_method !== 'Cash on Delivery') {
      return new Response(
        JSON.stringify({ error: 'Only Cash on Delivery is currently supported' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Order must contain at least one item' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);

      if (!item.name || !Number.isInteger(quantity) || quantity < 1) {
        return new Response(
          JSON.stringify({ error: 'Invalid order item' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      const price = getProductPrice(item.name);

      if (price === null) {
        return new Response(
          JSON.stringify({ error: `Invalid product: ${item.name}` }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      subtotal += price * quantity;

      verifiedItems.push({
        name: item.name,
        quantity,
        price
      });
    }

    const orderId =
      'SK-' +
      crypto.randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase();

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
        status,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        orderId,
        createdAt,
        customer_name.trim(),
        customer_phone.trim(),
        customer_address.trim(),
        customer_city.trim(),
        'Cash on Delivery',
        JSON.stringify(verifiedItems),
        subtotal,
        'new',
        ''
      )
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        order_id: orderId,
        subtotal
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Unable to create order'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

export async function onRequestGet({ request, env }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('q');

  let query = `
    SELECT *
    FROM orders
  `;

  const conditions = [];
  const bindings = [];

  if (status) {
    conditions.push('status = ?');
    bindings.push(status);
  }

  if (search) {
    conditions.push(`
      (
        customer_name LIKE ?
        OR customer_phone LIKE ?
        OR id LIKE ?
      )
    `);

    const term = `%${search}%`;
    bindings.push(term, term, term);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  const result = await env.DB
    .prepare(query)
    .bind(...bindings)
    .all();

  return new Response(
    JSON.stringify({
      orders: result.results || []
    }),
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

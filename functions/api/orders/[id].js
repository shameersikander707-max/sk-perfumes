
import { validSession } from '../../_lib/auth.js';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

const ALLOWED = [
  'new',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned'
];

export async function onRequestPatch({ request, env, params }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  if (!ALLOWED.includes(body.status)) {
    return json({ ok: false, error: 'Invalid status.' }, 400);
  }

  const orderId = String(params.id || '');
  const nextStatus = body.status;
  const notes = String(body.notes || '').slice(0, 2000);

  let order;

  try {
    order = await env.DB.prepare(`
      SELECT id, status, items_json, inventory_state
      FROM orders
      WHERE id = ?
    `).bind(orderId).first();
  } catch {
    return json({ ok: false, error: 'Unable to load order.' }, 500);
  }

  if (!order) {
    return json({ ok: false, error: 'Order not found.' }, 404);
  }

  const state = order.inventory_state || 'untracked';

  // Existing orders that predate inventory tracking remain untracked.
  if (state === 'untracked') {
    try {
      await env.DB.prepare(`
        UPDATE orders
        SET status = ?, notes = ?
        WHERE id = ? AND inventory_state = 'untracked'
      `).bind(nextStatus, notes, orderId).run();

      return json({ ok: true });
    } catch {
      return json({ ok: false, error: 'Unable to update order.' }, 500);
    }
  }

  // Don't let a cancelled order become active without a new reservation.
  if (state === 'released' && nextStatus !== 'cancelled') {
    return json({
      ok: false,
      error: 'This order has released its stock. A new reservation is required before reactivation.'
    }, 409);
  }

  if (state === 'sold' && !['delivered', 'returned'].includes(nextStatus)) {
    return json({
      ok: false,
      error: 'A delivered order cannot be moved back to an earlier status. Use Returned if the customer sends it back.'
    }, 409);
  }

  if (state === 'returned_pending' && nextStatus !== 'returned') {
    return json({
      ok: false,
      error: 'This return is awaiting inspection. Its inventory must be reviewed before further changes.'
    }, 409);
  }

  if (state === 'restocked' && nextStatus !== 'returned') {
    return json({
      ok: false,
      error: 'This returned order has already been restocked.'
    }, 409);
  }

  if (state === 'reserved' && nextStatus === 'returned') {
    return json({
      ok: false,
      error: 'Mark the order Delivered before marking it Returned.'
    }, 409);
  }

  let items;

  try {
    items = JSON.parse(order.items_json);
    if (!Array.isArray(items) || !items.length) throw new Error('Invalid items');
  } catch {
    return json({ ok: false, error: 'Order items are invalid.' }, 500);
  }

  const releasesStock = state === 'reserved' && nextStatus === 'cancelled';
  const completesSale = state === 'reserved' && nextStatus === 'delivered';
  const startsReturn = state === 'sold' && nextStatus === 'returned';

  // Resolve product IDs from the database, never from browser-supplied IDs.
  const names = [...new Set(items.map(item => String(item.name || '')))];

  let productResult;

  try {
    productResult = await env.DB.prepare(`
      SELECT id, name
      FROM products
      WHERE name IN (${names.map(() => '?').join(',')})
    `).bind(...names).all();
  } catch {
    return json({ ok: false, error: 'Unable to verify order products.' }, 500);
  }

  const productByName = new Map(
    (productResult.results || []).map(p => [p.name, p])
  );

  const orderItems = [];

  for (const item of items) {
    const product = productByName.get(String(item.name || ''));
    const qty = Number(item.qty);

    if (!product || !Number.isInteger(qty) || qty < 1) {
      return json({
        ok: false,
        error: 'A product or quantity in this order is invalid.'
      }, 500);
    }

    const existing = orderItems.find(x => x.productId === product.id);

    if (existing) {
      existing.qty += qty;
    } else {
      orderItems.push({
        productId: product.id,
        name: product.name,
        qty
      });
    }
  }

  const nextInventoryState = releasesStock
    ? 'released'
    : completesSale
      ? 'sold'
      : startsReturn
        ? 'returned_pending'
        : state;

  // Guard the state change. All inventory operations below are conditional
  // on the resulting order state, so a competing request cannot release
  // stock after another request has delivered the order.
  const statements = [
    env.DB.prepare(`
      UPDATE orders
      SET status = ?, notes = ?, inventory_state = ?
      WHERE id = ?
        AND inventory_state = ?
    `).bind(nextStatus, notes, nextInventoryState, orderId, state)
  ];

  for (const item of orderItems) {
    if (releasesStock) {
      statements.push(
        env.DB.prepare(`
          UPDATE products
          SET stock = stock + ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM orders
              WHERE id = ?
                AND inventory_state = 'released'
                AND status = 'cancelled'
            )
            AND NOT EXISTS (
              SELECT 1 FROM inventory_movements
              WHERE order_id = ?
                AND product_id = ?
                AND movement_type = 'release'
            )
        `).bind(
          item.qty,
          item.productId,
          orderId,
          orderId,
          item.productId
        )
      );

      statements.push(
        env.DB.prepare(`
          INSERT INTO inventory_movements
            (product_id, order_id, movement_type, quantity, note)
          SELECT ?, ?, 'release', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM orders
            WHERE id = ?
              AND inventory_state = 'released'
              AND status = 'cancelled'
          )
          AND NOT EXISTS (
            SELECT 1 FROM inventory_movements
            WHERE order_id = ?
              AND product_id = ?
              AND movement_type = 'release'
          )
        `).bind(
          item.productId,
          orderId,
          item.qty,
          `Reservation released for cancelled order ${orderId}`,
          orderId,
          orderId,
          item.productId
        )
      );
    }

    if (completesSale) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO inventory_movements
            (product_id, order_id, movement_type, quantity, note)
          SELECT ?, ?, 'sale', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM orders
            WHERE id = ?
              AND inventory_state = 'sold'
              AND status = 'delivered'
          )
          AND NOT EXISTS (
            SELECT 1 FROM inventory_movements
            WHERE order_id = ?
              AND product_id = ?
              AND movement_type = 'sale'
          )
        `).bind(
          item.productId,
          orderId,
          item.qty,
          `Sale completed for order ${orderId}`,
          orderId,
          orderId,
          item.productId
        )
      );
    }
  }

  try {
    await env.DB.batch(statements);
  } catch {
    return json({
      ok: false,
      error: 'The order or inventory changed during this update. Refresh the dashboard and try again.'
    }, 409);
  }

  if (startsReturn) {
    return json({
      ok: true,
      inventoryMessage: 'Return recorded; inspect the items before restocking.'
    });
  }

  return json({ ok: true });
}

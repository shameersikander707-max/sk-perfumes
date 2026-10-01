import { validSession } from '../_lib/auth.js';

export async function onRequestPatch({ request, env, params }) {
  if (!(await validSession(request, env.ADMIN_SESSION_SECRET))) {
    return Response.json(
      { ok: false, error: 'Unauthorized.' },
      { status: 401 }
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: 'Invalid request.' },
      { status: 400 }
    );
  }

  const allowed = [
    'new',
    'confirmed',
    'packed',
    'shipped',
    'delivered',
    'cancelled',
    'returned'
  ];

  if (!allowed.includes(body.status)) {
    return Response.json(
      { ok: false, error: 'Invalid status.' },
      { status: 400 }
    );
  }

  const result = await env.DB
    .prepare(
      'UPDATE orders SET status=?, notes=? WHERE id=?'
    )
    .bind(
      body.status,
      String(body.notes || ''),
      params.id
    )
    .run();

  if (!result.meta?.changes) {
    return Response.json(
      { ok: false, error: 'Order not found.' },
      { status: 404 }
    );
  }

  return Response.json({ ok: true });
}

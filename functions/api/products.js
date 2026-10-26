
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestGet({ env }) {
  try {
    const result = await env.DB.prepare(`
      SELECT id, name, price, stock, active
      FROM products
      WHERE active = 1
      ORDER BY name
    `).all();

    return json({
      ok: true,
      products: (result.results || []).map(product => ({
        id: product.id,
        name: product.name,
        price: product.price,
        stock: product.stock,
        available: product.stock > 0
      }))
    });
  } catch {
    return json({
      ok: false,
      error: 'Unable to load products.'
    }, 500);
  }
}

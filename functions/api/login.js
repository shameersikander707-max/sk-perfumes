import { makeSession, sessionCookie } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const password = String(body?.password || '');

    if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
      return Response.json({ ok: false, error: 'Invalid password' }, { status: 401 });
    }

    const token = await makeSession(env.ADMIN_SESSION_SECRET);

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch {
    return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 });
  }
}

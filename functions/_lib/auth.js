const COOKIE = 'sk_admin_session';
const TTL = 60 * 60 * 8;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - str.length % 4) : '';
  const bin = atob(str.replace(/-/g,'+').replace(/_/g,'/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
export async function makeSession(secret) {
  const exp = Math.floor(Date.now()/1000) + TTL;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({role:'admin',exp})));
  const sig = b64url(await hmac(secret, payload));
  return payload + '.' + sig;
}
export async function validSession(request, secret) {
  if (!secret) return false;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!match) return false;
  const token = match[1];
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const payloadBytes = unb64url(parts[0]);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload.exp || payload.exp < Math.floor(Date.now()/1000)) return false;
    const expected = await hmac(secret, parts[0]);
    const actual = unb64url(parts[1]);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i=0;i<expected.length;i++) diff |= expected[i] ^ actual[i];
    return diff === 0 && payload.role === 'admin';
  } catch { return false; }
}
export function sessionCookie(token) {
  return `${COOKIE}=${token}; Max-Age=${TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
export function clearCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
export async function requireAdmin(request, env) {
  return validSession(request, env.ADMIN_SESSION_SECRET);
}

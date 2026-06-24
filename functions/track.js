export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const { event, message, browser, pageUrl } = body;
  if (!event) return new Response('Missing event', { status: 400 });

  const country = request.cf?.country ?? null;
  const city    = request.cf?.city    ?? null;

  await env.DB.prepare(
    'INSERT INTO events (event, message, browser, url, country, city) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    String(event).slice(0, 100),
    message ? String(message).slice(0, 500) : null,
    browser ? String(browser).slice(0, 200) : null,
    pageUrl ? String(pageUrl).slice(0, 500) : null,
    country,
    city
  ).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/track') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }

      const { event, message, browser, pageUrl } = body;
      if (!event) return new Response('Missing event', { status: 400 });

      await env.DB.prepare(
        'INSERT INTO events (event, message, browser, url) VALUES (?, ?, ?, ?)'
      ).bind(
        String(event).slice(0, 100),
        message ? String(message).slice(0, 500) : null,
        browser ? String(browser).slice(0, 200) : null,
        pageUrl ? String(pageUrl).slice(0, 500) : null
      ).run();

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      const [summary, recent] = await Promise.all([
        env.DB.prepare(
          `SELECT event, message, COUNT(*) as count
           FROM events
           GROUP BY event, message
           ORDER BY count DESC`
        ).all(),
        env.DB.prepare(
          `SELECT event, message, browser, url, ts
           FROM events
           ORDER BY ts DESC
           LIMIT 50`
        ).all(),
      ]);

      const html = buildAdminHtml(summary.results, recent.results);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

function buildAdminHtml(summary, recent) {
  const summaryRows = summary.map(r => `
    <tr>
      <td>${esc(r.event)}</td>
      <td>${esc(r.message ?? '—')}</td>
      <td>${r.count}</td>
    </tr>`).join('');

  const recentRows = recent.map(r => `
    <tr>
      <td>${esc(r.ts)}</td>
      <td>${esc(r.event)}</td>
      <td>${esc(r.message ?? '—')}</td>
      <td title="${esc(r.browser ?? '')}">${esc(shortBrowser(r.browser))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GamePointLA — Analytics</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    h2 { font-size: 1rem; margin: 32px 0 8px; color: #444; text-transform: uppercase; letter-spacing: .05em; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th { text-align: left; border-bottom: 2px solid #ddd; padding: 6px 10px; }
    td { border-bottom: 1px solid #eee; padding: 6px 10px; vertical-align: top; word-break: break-word; }
    tr:hover td { background: #f9f9f9; }
    .count { font-weight: 600; color: #c0392b; }
    .empty { color: #888; font-style: italic; padding: 12px 0; }
  </style>
</head>
<body>
  <h1>GamePointLA Analytics</h1>
  <p style="color:#888;font-size:.85rem">All times UTC</p>

  <h2>Error summary</h2>
  <table>
    <thead><tr><th>Event</th><th>Message</th><th>Count</th></tr></thead>
    <tbody>${summaryRows || '<tr><td colspan="3" class="empty">No events yet</td></tr>'}</tbody>
  </table>

  <h2>Recent events (last 50)</h2>
  <table>
    <thead><tr><th>Time</th><th>Event</th><th>Message</th><th>Browser</th></tr></thead>
    <tbody>${recentRows || '<tr><td colspan="4" class="empty">No events yet</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortBrowser(ua) {
  if (!ua) return '—';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari';
  return ua.slice(0, 30);
}

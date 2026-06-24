export async function onRequestGet({ env }) {
  const [summary, byCountry, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT event, message, COUNT(*) as count
       FROM events
       GROUP BY event, message
       ORDER BY count DESC`
    ).all(),
    env.DB.prepare(
      `SELECT country, COUNT(*) as count
       FROM events
       WHERE event = 'page_view'
       GROUP BY country
       ORDER BY count DESC
       LIMIT 20`
    ).all(),
    env.DB.prepare(
      `SELECT event, message, browser, url, country, city, ts
       FROM events
       ORDER BY ts DESC
       LIMIT 50`
    ).all(),
  ]);

  const html = buildAdminHtml(summary.results, byCountry.results, recent.results);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

function buildAdminHtml(summary, byCountry, recent) {
  const totalViews = summary.find(r => r.event === 'page_view')?.count ?? 0;

  const summaryRows = summary.map(r => `
    <tr>
      <td>${esc(r.event)}</td>
      <td>${esc(r.message ?? '—')}</td>
      <td>${r.count}</td>
    </tr>`).join('');

  const countryRows = byCountry.map(r => `
    <tr>
      <td>${esc(r.country ?? '—')}</td>
      <td>${r.count}</td>
    </tr>`).join('');

  const recentRows = recent.map(r => `
    <tr>
      <td>${esc(r.ts)}</td>
      <td>${esc(r.event)}</td>
      <td>${esc(r.message ?? '—')}</td>
      <td title="${esc(r.browser ?? '')}">${esc(shortBrowser(r.browser))}</td>
      <td>${esc(r.city ?? '—')}, ${esc(r.country ?? '—')}</td>
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
    .empty { color: #888; font-style: italic; padding: 12px 0; }
  </style>
</head>
<body>
  <h1>GamePointLA Analytics</h1>
  <p style="color:#888;font-size:.85rem">All times UTC &nbsp;·&nbsp; <strong>${totalViews}</strong> total page views</p>

  <h2>Page views by country</h2>
  <table>
    <thead><tr><th>Country</th><th>Views</th></tr></thead>
    <tbody>${countryRows || '<tr><td colspan="2" class="empty">No page views yet</td></tr>'}</tbody>
  </table>

  <h2>Event summary</h2>
  <table>
    <thead><tr><th>Event</th><th>Message</th><th>Count</th></tr></thead>
    <tbody>${summaryRows || '<tr><td colspan="3" class="empty">No events yet</td></tr>'}</tbody>
  </table>

  <h2>Recent events (last 50)</h2>
  <table>
    <thead><tr><th>Time</th><th>Event</th><th>Message</th><th>Browser</th><th>Location</th></tr></thead>
    <tbody>${recentRows || '<tr><td colspan="5" class="empty">No events yet</td></tr>'}</tbody>
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

function trackEvent(event, data = {}) {
  fetch('/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      message: data.message || null,
      browser: navigator.userAgent,
      pageUrl: location.href,
    }),
  }).catch(() => {});
}

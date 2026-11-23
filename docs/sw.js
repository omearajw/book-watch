self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { data = { title: 'Book Watch', body: event.data?.text() ?? '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Book Watch', {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || './'));
});

const SW_VER = 'v4';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  // 全キャッシュを削除してから制御を取得（古いHTMLを完全に排除）
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) {
        return caches.delete(name);
      }));
    }).then(function() {
      return clients.claim();
    })
  );
});

// index.html は常にネットワークから取得（キャッシュ禁止）
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(function() {
        return new Response('Network error. Please reconnect and refresh.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
    );
    return;
  }
});

self.addEventListener('push', function(e) {
  var data = e.data ? e.data.json() : {title:'StockEdge', body:'シグナル更新'};
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icon-192.png', badge: '/icon-192.png',
    vibrate: [200,100,200]
  }));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});

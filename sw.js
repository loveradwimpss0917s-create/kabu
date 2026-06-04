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

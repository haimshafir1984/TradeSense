self.addEventListener('push', event => {
  let message; try {message=event.data.json();} catch {return;}
  event.waitUntil(self.registration.showNotification(message.title,{body:message.body,tag:message.id,data:{url:'/'},dir:'rtl',lang:'he'}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>{
    const existing=windows.find(w=>new URL(w.url).origin===self.location.origin);
    return existing?existing.focus():clients.openWindow('/');
  }));
});

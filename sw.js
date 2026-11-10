// Город Хозяев: служебный файл, чтобы игру можно было установить на главный экран.
// Ничего не кэширует: игра всегда грузится свежей с сайта.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => { if (e.request.method === "GET" && e.request.mode === "navigate") e.respondWith(fetch(e.request).catch(() => new Response("<meta charset=utf-8><body style='background:#0B0E1A;color:#fff;font-family:sans-serif;text-align:center;padding-top:40vh'>Нет интернета. Город Хозяев откроется, когда связь появится.</body>", { headers: { "content-type": "text/html; charset=utf-8" } }))); });

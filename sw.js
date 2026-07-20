// TaskFlow Beyond 3.a — Service Worker (opsional, PWA/offline)
// Hanya aktif kalau file ini disajikan lewat server (http/https) satu folder
// bersama TaskFlow-Next.html & manifest.json. Tidak berpengaruh apa pun kalau
// dibuka langsung dari file lokal (file://).

const CACHE_NAME = 'taskflow-beyond-3a-v1';
// Sengaja hanya menyimpan shell (halaman itu sendiri) — library CDN eksternal
// (pdf.js, tesseract, dsb) tetap diambil online seperti biasa saat tersedia,
// dan gagal secara wajar (bukan mem-block halaman) saat offline.
const APP_SHELL = [
    './',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Strategi: network-first untuk dokumen HTML utama (supaya selalu dapat versi
// terbaru saat online), fallback ke cache saat offline. Cache-first untuk aset
// statis lain yang sudah pernah diambil.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const isNavigation = event.request.mode === 'navigate';

    if (isNavigation) {
        event.respondWith(
            fetch(event.request)
                .then((res) => {
                    const resClone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
                    return res;
                })
                .catch(() => caches.match(event.request).then((r) => r || caches.match('./')))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((res) => {
                if (res && res.status === 200 && res.type === 'basic') {
                    const resClone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
        })
    );
});

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Gen3ia - Agents IA Autonomes',
    short_name: 'Gen3ia',
    description: 'Plateforme SaaS d\'agents IA autonomes pour enterprise',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

// Service Worker pour offline
// public/sw.js
const CACHE_NAME = 'gen3ia-v1';
const STATIC_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
  // CSS/JS critiques
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  // Cache-first pour assets statiques
  if (request.destination === 'image' || 
      request.url.includes('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => 
        cached || fetch(request)
      )
    );
    return;
  }
  
  // Network-first pour API avec cache offline
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => 
            cache.put(request, clone)
          );
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
});

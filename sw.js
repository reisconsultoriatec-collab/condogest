/* ===========================================================================
   CondoGest - Service Worker
   ---------------------------------------------------------------------------
   Estratégia:
   - App shell (index.html): network-first. O app é um arquivo único, então
     uma publicação nova precisa chegar rápido; o cache só entra em cena
     quando a rede falha (offline).
   - Estáticos próprios (ícones, manifest): cache-first.
   - Bibliotecas de CDN (fontes, Chart.js, SheetJS, Tesseract, Firebase SDK):
     stale-while-revalidate, para o app abrir rápido e atualizar em segundo
     plano.
   - Firestore / Auth / Storage: NUNCA passam pelo cache. São dados vivos e
     usam long-polling e websocket; qualquer interferência quebra o app.

   Para publicar uma versão nova, basta subir o index.html: o navegador
   detecta a mudança deste arquivo pelo CACHE_VERSION abaixo. Incremente-o
   sempre que mexer na lista de PRECACHE.
   =========================================================================== */

const CACHE_VERSION = 'v1.0.0';
const CACHE_SHELL = `condogest-shell-${CACHE_VERSION}`;
const CACHE_CDN = `condogest-cdn-${CACHE_VERSION}`;

// Arquivos do próprio app, baixados já na instalação
const PRECACHE = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-96x96.png',
    './icons/icon-192x192.png',
    './icons/icon-512x512.png',
    './icons/maskable-192x192.png',
    './icons/maskable-512x512.png'
];

// Domínios de dados: passam direto para a rede, sempre
const DOMINIOS_VIVOS = [
    'firestore.googleapis.com',
    'firebaseio.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'firebasestorage.googleapis.com',
    'www.googleapis.com'
];

// CDNs de bibliotecas: vale guardar
const DOMINIOS_CDN = [
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'www.gstatic.com'
];

const ehDominio = (url, lista) => lista.some(d => url.hostname === d || url.hostname.endsWith('.' + d));

// ---------- Instalação ----------
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_SHELL);
        // addAll falha inteiro se um arquivo faltar; aqui cada um é independente
        await Promise.all(PRECACHE.map(async url => {
            try {
                const resp = await fetch(url, { cache: 'reload' });
                if (resp.ok) await cache.put(url, resp);
            } catch (e) {
                console.warn('[SW] Não consegui pré-cachear', url, e.message);
            }
        }));
    })());
});

// ---------- Ativação: limpa caches de versões antigas ----------
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const nomes = await caches.keys();
        await Promise.all(
            nomes
                .filter(n => n.startsWith('condogest-') && n !== CACHE_SHELL && n !== CACHE_CDN)
                .map(n => caches.delete(n))
        );
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch (e) { /* ignora */ }
        }
        // De propósito, NÃO chamamos self.clients.claim() aqui.
        // O index.html recarrega a página em 'controllerchange'; com o claim,
        // a primeira visita de cada usuário recarregaria sozinha, na cara dele.
        // Sem o claim, este service worker passa a controlar a partir da
        // próxima abertura do app — que é o comportamento esperado.
    })());
});

// ---------- Mensagem vinda do app (banner "Atualizar agora") ----------
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------- Interceptação ----------
self.addEventListener('fetch', event => {
    const req = event.request;

    // Só GET. POST/PUT (Firestore, Auth) passam direto.
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (e) { return; }

    // Dados vivos: nunca tocar
    if (ehDominio(url, DOMINIOS_VIVOS)) return;

    // Extensões do navegador e afins
    if (!url.protocol.startsWith('http')) return;

    // Navegação (abrir o app): rede primeiro, cache como rede de segurança
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const preload = await event.preloadResponse;
                if (preload) {
                    const c = await caches.open(CACHE_SHELL);
                    c.put('./index.html', preload.clone());
                    return preload;
                }
                const resp = await fetch(req);
                const c = await caches.open(CACHE_SHELL);
                c.put('./index.html', resp.clone());
                return resp;
            } catch (e) {
                const cache = await caches.open(CACHE_SHELL);
                return (await cache.match('./index.html')) ||
                       (await cache.match('./')) ||
                       new Response(
                           '<h1>CondoGest</h1><p>Você está sem conexão e o app ainda não foi guardado para uso offline. Conecte-se à internet e abra novamente.</p>',
                           { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
                       );
            }
        })());
        return;
    }

    // Bibliotecas de CDN: devolve o cache e atualiza por trás
    if (ehDominio(url, DOMINIOS_CDN)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_CDN);
            const guardado = await cache.match(req);
            const rede = fetch(req).then(resp => {
                // opaque (no-cors) também serve para fontes
                if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
                return resp;
            }).catch(() => null);
            return guardado || (await rede) || new Response('', { status: 504 });
        })());
        return;
    }

    // Estáticos do próprio app: cache primeiro
    if (url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_SHELL);
            const guardado = await cache.match(req);
            if (guardado) return guardado;
            try {
                const resp = await fetch(req);
                if (resp.ok) cache.put(req, resp.clone());
                return resp;
            } catch (e) {
                return new Response('', { status: 504 });
            }
        })());
    }
});

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import runtime from '../lib/runtime.cjs';

const { validateConfig, lookupCountry } = runtime;

// ============================================================================
// CONSTANTES DE ARQUITETURA E SEGURANÇA
// ============================================================================
const ALLOWED_COUNTRIES = new Set(['MX', 'CL', 'CO', 'PE']);
const GEO_TIMEOUT_MS = 800;         // 800ms de Hard Timeout para API externa
const GEO_CACHE_MAX_SIZE = 5_000;   // Máximo de IPs salvos no cache LRU em memória
const GEO_CACHE_TTL_MS = 300_000;   // 5 minutos de cache por IP consultado
const MAX_QUERY_PARAMS = 20;        // Limite contra sobrecarga de Query String

// Regex para remover caracteres de controle ASCII (Prevenção de Header Injection / Cache Splitting)
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;

// ============================================================================
// 1. CONFIGURAÇÃO CARREGADA UMA VEZ POR INSTÂNCIA & LOOKUP POR MAP
// ============================================================================
const configPath = path.join(process.cwd(), 'config.json');
let configPromise = null;

/**
 * O arquivo está incluído no pacote da função. Uma nova versão exige novo deploy.
 */
async function loadConfigFromDisk() {
    const rawData = await fs.readFile(configPath, 'utf8');
    const parsed = validateConfig(JSON.parse(rawData));
    const whitePage = sanitizeBaseUrl(parsed.white_page);
    if (!whitePage) throw new Error('URL de white_page inválida na configuração.');

    const offersMap = new Map();
    for (const offer of parsed.offers) {
        if (offer.status !== 'active') continue;
        const moneyUrl = sanitizeBaseUrl(offer.money_url);
        if (!moneyUrl) throw new Error(`URL inválida para ad_id ${offer.ad_id}.`);
        const adId = offer.ad_id.trim();
        offersMap.set(adId, Object.freeze({
            ad_id: adId,
            money_url: moneyUrl,
            status: 'active'
        }));
    }

    return { whitePage, offersMap };
}

function getConfig() {
    if (!configPromise) {
        configPromise = loadConfigFromDisk().catch(error => {
            configPromise = null;
            console.error('[CONFIG_LOAD_ERROR]', { message: error.message });
            throw error;
        });
    }
    return configPromise;
}

// ============================================================================
// 3. TIMEOUT ESTRITO COM ABORTCONTROLLER + CACHE LRU DE GEOLOCALIZAÇÃO
// ============================================================================
const geoCache = new Map(); // Funciona como LRU aproveitando a ordem de inserção do Map no JS
const geoLookupsInFlight = new Map(); // Compartilha consultas simultâneas para o mesmo IP

function getCachedCountry(ip) {
    const entry = geoCache.get(ip);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
        geoCache.delete(ip);
        return null;
    }

    // Atualiza posição no LRU (remove e reinsere no final)
    geoCache.delete(ip);
    geoCache.set(ip, entry);
    return entry.country;
}

function setCachedCountry(ip, country) {
    if (geoCache.size >= GEO_CACHE_MAX_SIZE) {
        // Remove o item mais antigo (primeiro elemento do Map)
        const oldestKey = geoCache.keys().next().value;
        geoCache.delete(oldestKey);
    }
    geoCache.set(ip, {
        country,
        expiresAt: Date.now() + GEO_CACHE_TTL_MS
    });
}

/**
 * Executa a busca de país com AbortController real e Hard Timeout de 800ms
 */
async function fetchCountryWithAbort(ip, timeoutMs) {
    const controller = new AbortController();
    const { signal } = controller;
    let timerId;

    const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            controller.abort(); // Envia sinal de aborto para a operação subjacente
            const err = new Error(`GeoIP excedeu o limite estrito de ${timeoutMs}ms`);
            err.name = 'AbortError';
            reject(err);
        }, timeoutMs);
    });

    try {
        // O sinal cancela a consulta subjacente quando o limite é atingido.
        const result = await Promise.race([
            lookupCountry(ip, { signal }),
            timeoutPromise
        ]);

        const normalized = typeof result === 'string' ? result.trim().toUpperCase() : '';
        if (/^[A-Z]{2}$/.test(normalized)) {
            setCachedCountry(ip, normalized);
            return normalized;
        }
        return null;
    } finally {
        clearTimeout(timerId);
    }
}

function resolveCountryWithAbort(ip, timeoutMs) {
    const cached = getCachedCountry(ip);
    if (cached) return Promise.resolve(cached);

    const inFlight = geoLookupsInFlight.get(ip);
    if (inFlight) return inFlight;

    const pending = fetchCountryWithAbort(ip, timeoutMs);
    geoLookupsInFlight.set(ip, pending);
    const clearInFlight = () => {
        if (geoLookupsInFlight.get(ip) === pending) {
            geoLookupsInFlight.delete(ip);
        }
    };
    void pending.then(clearInFlight, clearInFlight);
    return pending;
}

// ============================================================================
// 4. VALIDAÇÃO DE FORMATO DE IP E SANITIZAÇÃO RIGOROSA (IPv4 / IPv6 / RFCs)
// ============================================================================
function extractAndSanitizeIp(req) {
    const headerCandidate = req.headers['cf-connecting-ip']
                         || req.headers['x-real-ip']
                         || req.headers['x-forwarded-for'];

    let raw = '';
    if (typeof headerCandidate === 'string' && headerCandidate.length > 0) {
        raw = headerCandidate.split(',')[0].trim();
    } else if (typeof req.socket?.remoteAddress === 'string') {
        raw = req.socket.remoteAddress.trim();
    }

    if (!raw || raw.length > 64) return null;

    // 1. Trata notação IPv6 com colchetes e porta: ex: [2001:db8::1]:44321 -> 2001:db8::1
    if (raw.startsWith('[')) {
        const closeBracketIdx = raw.indexOf(']');
        if (closeBracketIdx === -1) return null;
        raw = raw.slice(1, closeBracketIdx);
    }

    // 2. Remove Zone Index de IPv6 (ex: fe80::1%eth0 -> fe80::1)
    const zoneIdx = raw.indexOf('%');
    if (zoneIdx !== -1) {
        raw = raw.slice(0, zoneIdx);
    }

    // 3. Converte IPv4 mapeado em IPv6 (ex: ::ffff:189.10.20.30 -> 189.10.20.30)
    if (raw.toLowerCase().startsWith('::ffff:')) {
        raw = raw.slice(7);
    }

    // 4. Remove porta acoplada em IPv4 (ex: 189.10.20.30:54321 -> 189.10.20.30)
    // Se houver apenas um ':' na string, trata-se de IPv4:Porta (IPv6 possui no mínimo dois ':')
    const firstColon = raw.indexOf(':');
    if (firstColon !== -1 && raw.indexOf(':', firstColon + 1) === -1) {
        raw = raw.slice(0, firstColon);
    }

    const ipVersion = net.isIP(raw);
    if (ipVersion === 0) return null;

    return { ip: raw, version: ipVersion };
}

/**
 * Filtra IPs de Loopback, Redes Privadas (RFC 1918), CGNAT (RFC 6598) e Link-Local
 */
function isReservedOrPrivateIp({ ip, version }) {
    if (version === 4) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;

        if (a === 10) return true;                          // 10.0.0.0/8 (Privado)
        if (a === 127) return true;                         // 127.0.0.0/8 (Loopback)
        if (a === 0) return true;                           // 0.0.0.0/8 (Rede local)
        if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (Link-Local)
        if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 (Privado)
        if (a === 192 && b === 168) return true;            // 192.168.0.0/16 (Privado)
        if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (Carrier-Grade NAT)
        return false;
    }

    if (version === 6) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1' || normalized === '::') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique Local (RFC 4193)
        if (/^fe[89ab]/.test(normalized)) return true; // Link-Local (fe80::/10)
        return false;
    }

    return true;
}

// ============================================================================
// 5. PREVENÇÃO DE CACHE SPLITTING, HPP E SANITIZAÇÃO DE URL
// ============================================================================
function sanitizeBaseUrl(urlString) {
    if (typeof urlString !== 'string') return null;
    const cleaned = urlString.replace(CONTROL_CHARS_REGEX, '').trim();
    try {
        const parsed = new URL(cleaned);
        // Impede esquemas perigosos como javascript:, data:, file:
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

/**
 * Mescla Query Strings protegendo contra HTTP Parameter Pollution (HPP) e CRLF Injection
 */
function buildSafeRedirectUrl(baseUrl, queryObj) {
    try {
        const targetUrl = new URL(baseUrl);
        if (!queryObj || typeof queryObj !== 'object') {
            return targetUrl.toString();
        }

        let paramCount = 0;
        for (const [rawKey, rawVal] of Object.entries(queryObj)) {
            if (paramCount >= MAX_QUERY_PARAMS) break;
            if (rawKey === 'ad_id') continue;

            // Prevenção de HPP: se o parâmetro vier duplicado (Array), pega apenas o primeiro valor
            const singleVal = Array.isArray(rawVal) ? rawVal[0] : rawVal;
            if (typeof singleVal !== 'string') continue;

            // Remove caracteres de controle (\r, \n, \0) que causam HTTP Response/Cache Splitting
            const safeKey = rawKey.replace(CONTROL_CHARS_REGEX, '').trim();
            const safeVal = singleVal.replace(CONTROL_CHARS_REGEX, '').trim();

            if (safeKey.length > 0 && safeKey.length <= 64 && safeVal.length <= 256) {
                targetUrl.searchParams.set(safeKey, safeVal);
                paramCount++;
            }
        }

        return targetUrl.toString();
    } catch {
        return baseUrl;
    }
}

// ============================================================================
// HANDLER PRINCIPAL DA ROTA
// ============================================================================
export default async function handler(req, res) {
    // 1. Rejeição imediata de métodos HTTP inválidos (Prevenção de abuso e Cache Poisoning)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(405).send('Method Not Allowed');
    }

    // 2. Cabeçalhos estritos contra Cache Splitting e armazenamento indevido em Proxies/CDNs
    res.setHeader('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // 3. Obtém a configuração empacotada neste deploy
    let store;
    try {
        store = await getConfig();
    } catch {
        return res.status(500).send('Internal Configuration Error');
    }

    const fallbackUrl = store.whitePage;

    // 4. Sanitização do parâmetro ad_id (protegido contra Array Injection / HPP)
    const rawAdId = Array.isArray(req.query?.ad_id) ? req.query.ad_id[0] : req.query?.ad_id;
    const adId = typeof rawAdId === 'string'
        ? rawAdId.replace(CONTROL_CHARS_REGEX, '').trim()
        : null;

    // 5. Lookup O(1) imediato: se o ad_id não existir ou estiver inativo, encerra antes do GeoIP
    if (!adId || !store.offersMap.has(adId)) {
        return res.redirect(302, fallbackUrl);
    }

    // 6. Extração, limpeza e validação RFC do endereço IP
    const parsedIp = extractAndSanitizeIp(req);
    if (!parsedIp || isReservedOrPrivateIp(parsedIp)) {
        return res.redirect(302, fallbackUrl);
    }

    // 7. Consulta externa protegida por AbortController (Hard Timeout de 800ms) + Cache LRU
    const lookupStartedAt = performance.now();
    try {
        const countryCode = await resolveCountryWithAbort(parsedIp.ip, GEO_TIMEOUT_MS);

        if (countryCode && ALLOWED_COUNTRIES.has(countryCode)) {
            const offer = store.offersMap.get(adId);
            const destinationUrl = buildSafeRedirectUrl(offer.money_url, req.query);
            return res.redirect(302, destinationUrl);
        }
    } catch (error) {
        const durationMs = Math.round(performance.now() - lookupStartedAt);
        console.error('[GEO_LOOKUP_FAILURE]', {
            name: error.name,
            message: error.message,
            duration_ms: durationMs
        });

        return res.status(503).send('Consulta de localização temporariamente indisponível.');
    }

    return res.redirect(302, fallbackUrl);
}

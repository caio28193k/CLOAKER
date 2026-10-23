import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import runtime from '../lib/runtime.cjs';

const { validateConfig, lookupCountry } = runtime;

// Configurações de Resiliência
const ALLOWED_COUNTRIES = new Set(['MX', 'CL', 'CO', 'PE']);
const CONFIG_TTL_MS = 30_000; // Recarrega o config.json no máximo a cada 30s
const GEO_TIMEOUT_MS = 1_200; // Cancela o lookup de IP se demorar mais de 1.2s

// Estado em memória para alta performance
let configState = {
    data: null,
    offersMap: new Map(),
    lastLoadedAt: 0,
    loadingPromise: null
};

/**
 * Carrega e indexa o config.json com proteção contra Race Conditions (Stampede)
 * e mantém a última versão válida caso o arquivo seja corrompido durante edição.
 */
async function getIndexedConfig() {
    const now = Date.now();

    // Retorna do cache se ainda estiver dentro do TTL
    if (configState.data && (now - configState.lastLoadedAt < CONFIG_TTL_MS)) {
        return configState;
    }

    // Se já houver uma leitura de disco em andamento, aguarda a mesma Promise
    if (configState.loadingPromise) {
        return configState.loadingPromise;
    }

    configState.loadingPromise = (async () => {
        try {
            const filePath = path.join(process.cwd(), 'config.json');
            const rawData = await fs.readFile(filePath, 'utf8');
            const parsed = validateConfig(JSON.parse(rawData));

            // Indexa ofertas ativas em um Map para busca O(1) instantânea
            const newOffersMap = new Map();
            if (Array.isArray(parsed.offers)) {
                for (const offer of parsed.offers) {
                    if (offer.status === 'active' && offer.ad_id && offer.money_url) {
                        newOffersMap.set(String(offer.ad_id), offer);
                    }
                }
            }

            configState = {
                data: parsed,
                offersMap: newOffersMap,
                lastLoadedAt: Date.now(),
                loadingPromise: null
            };
            return configState;
        } catch (err) {
            configState.loadingPromise = null;
            console.error('[CRITICAL] Falha ao recarregar config.json:', err.message);

            // Resiliência: se já tínhamos um config válido antes, continua usando ele
            if (configState.data) {
                console.warn('[RECOVERY] Utilizando configuração anterior em cache.');
                configState.lastLoadedAt = Date.now(); // Evita loop de leitura de disco
                return configState;
            }
            throw err;
        }
    })();

    return configState.loadingPromise;
}

/**
 * Extrai, limpa e valida o endereço IP do cliente
 */
function extractCleanIp(req) {
    let rawIp = '';

    // Prioriza cabeçalhos de proxies reversos conhecidos, se presentes
    const forwarded = req.headers['cf-connecting-ip'] 
                   || req.headers['x-real-ip'] 
                   || req.headers['x-forwarded-for'];

    if (typeof forwarded === 'string' && forwarded.length > 0) {
        rawIp = forwarded.split(',')[0].trim();
    } else if (req.socket?.remoteAddress) {
        rawIp = req.socket.remoteAddress;
    }

    // Remove prefixo IPv6-mapped IPv4 (ex: ::ffff:192.168.1.1 -> 192.168.1.1)
    if (rawIp.startsWith('::ffff:')) {
        rawIp = rawIp.slice(7);
    }

    // Remove porta caso o proxy envie no formato IPv4:Porta (ex: 200.10.20.30:44321)
    if (rawIp.includes(':') && net.isIPv6(rawIp) === false) {
        rawIp = rawIp.split(':')[0];
    }

    // Retorna o IP apenas se for sintaticamente válido (IPv4 ou IPv6)
    return net.isIP(rawIp) !== 0 ? rawIp : null;
}

/**
 * Verifica se o IP pertence a redes locais/privadas (RFC 1918 / Loopback)
 */
function isPrivateOrLocalIp(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '::1') return true;
    return (
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        ip.startsWith('fc00:') ||
        ip.startsWith('fe80:')
    );
}

/**
 * Executa o lookup de país com Timeout estrito para não travar a Event Loop
 */
async function lookupCountryWithTimeout(ip, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`Geo lookup excedeu o limite de ${timeoutMs}ms`);
            err.name = 'TimeoutError';
            reject(err);
        }, timeoutMs);
    });

    try {
        return await Promise.race([lookupCountry(ip), timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Anexa parâmetros de campanha (UTMs, subids) com segurança na URL de destino
 */
function buildDestinationUrl(baseUrl, queryObj) {
    try {
        const target = new URL(baseUrl);
        for (const [key, value] of Object.entries(queryObj)) {
            if (key === 'ad_id') continue;
            if (typeof value === 'string' && value.length <= 256) {
                target.searchParams.set(key, value);
            }
        }
        return target.toString();
    } catch {
        return baseUrl;
    }
}

export default async function handler(req, res) {
    // 1. Filtra métodos HTTP desnecessários logo na entrada
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return res.status(405).end();
    }

    // 2. Cabeçalhos de segurança e controle estrito de cache
    res.setHeader('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // 3. Carregamento resiliente de configuração
    let state;
    try {
        state = await getIndexedConfig();
    } catch {
        return res.status(500).send('Service Configuration Error');
    }

    const fallbackUrl = state.data.white_page;
    const adId = typeof req.query?.ad_id === 'string' ? req.query.ad_id.trim() : null;

    // 4. Short-circuit: se não há ad_id válido ou a oferta não está ativa, nem gasta CPU/Rede consultando IP
    if (!adId || !state.offersMap.has(adId)) {
        return res.redirect(302, fallbackUrl);
    }

    // 5. Extração e validação de IP
    const clientIp = extractCleanIp(req);
    if (isPrivateOrLocalIp(clientIp)) {
        return res.redirect(302, fallbackUrl);
    }

    // 6. Consulta de Geolocalização protegida por Timeout
    const lookupStartedAt = performance.now();
    try {
        const countryCode = await lookupCountryWithTimeout(clientIp, GEO_TIMEOUT_MS);
        const normalizedCountry = typeof countryCode === 'string' ? countryCode.toUpperCase() : '';

        if (ALLOWED_COUNTRIES.has(normalizedCountry)) {
            const offer = state.offersMap.get(adId);
            const finalUrl = buildDestinationUrl(offer.money_url, req.query);
            return res.redirect(302, finalUrl);
        }
    } catch (error) {
        const durationMs = Math.round(performance.now() - lookupStartedAt);
        console.error('[GEO_LOOKUP_FAIL]', {
            type: error.name,
            message: error.message,
            ip: clientIp,
            duration_ms: durationMs
        });

        // Graceful Degradation: Em produção, se a API de GeoIP falhar ou der timeout,
        // redireciona para a página padrão em vez de exibir tela de erro 503 ao usuário.
        return res.redirect(302, fallbackUrl);
    }

    return res.redirect(302, fallbackUrl);
}

/**
 * Checagens extras de contradição para adicionar dentro de evaluateClientAuthenticity(req)
 */

// 7. Contradição Safari/iOS vs. Client Hints do Chromium:
// Navegadores Safari (iPhone/Mac) e Firefox NÃO enviam cabeçalhos 'sec-ch-ua'.
// Se o User-Agent finge ser um iPhone (Safari) ou Firefox, mas a requisição contém 'sec-ch-ua',
// prova-se que é um bot baseado em Chromium (Puppeteer/Playwright) com User-Agent falsificado!
const claimsSafariOrFirefox = (/iphone|ipad|macintosh/i.test(ua) && !/chrome|crios|edg/i.test(ua)) || /firefox\//i.test(ua);
if (claimsSafariOrFirefox && (h['sec-ch-ua'] || h['sec-ch-ua-platform'] || h['sec-ch-ua-mobile'])) {
    return { passed: false, reason: 'TLS_CLIENT_HINTS_UA_CONTRADICTION' };
}

// 8. Contradição de Plataforma (OS Spoofing):
// Se o cabeçalho nativo Sec-CH-UA-Platform diz "Linux" ou "Windows", mas o User-Agent diz "Android" ou "iPhone"
const chPlatform = typeof h['sec-ch-ua-platform'] === 'string' ? h['sec-ch-ua-platform'].toLowerCase() : '';
if (chPlatform) {
    if (chPlatform.includes('linux') && /windows|macintosh|iphone/i.test(ua)) {
        return { passed: false, reason: 'PLATFORM_HEADER_CONTRADICTION' };
    }
    if (chPlatform.includes('windows') && /android|iphone|ipad|linux/i.test(ua)) {
        return { passed: false, reason: 'PLATFORM_HEADER_CONTRADICTION' };
    }
}

// Adicione no final do seu arquivo handler.js (logo após a função handler):

// Permite injetar mocks durante os testes unitários sem afetar a produção
export function __resetForTests(overrides = {}) {
    configStore.whitePage = null;
    configStore.offersMap.clear();
    configStore.lastCheckedAt = 0;
    configStore.lastMtimeMs = 0;
    configStore.revalidatingPromise = null;
    geoCache.clear();

    if (overrides.lookupCountry) {
        lookupCountry = overrides.lookupCountry;
    }
    if (overrides.configPath) {
        configPath = overrides.configPath;
    }
}

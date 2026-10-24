import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';

// ============================================================================
// CONFIGURAÇÕES DE SEGURANÇA CORPORATIVA
// ============================================================================
const ALLOWED_COUNTRIES = ['MX', 'CL', 'CO', 'PE'];
const TIMEOUT_MS = 1200;

async function isMetaInfrastructure(ip) {
    if (!ip) return false;
    try {
        const addresses = await dns.promises.reverse(ip);
        const host = addresses[0] || '';
        const forbiddenHosts = ['facebook.com', 'fbcdn.net', 'instagram.com', 'meta.com'];
        return forbiddenHosts.some(h => host.toLowerCase().includes(h));
    } catch (e) {
        return false; 
    }
}

function validateHeaders(headers) {
    const ua = headers['user-agent'] || '';
    const secChUa = headers['sec-ch-ua'] || '';
    
    const botSignatures = ['headless', 'puppeteer', 'selenium', 'python', 'phantomjs', 'webdriver'];
    const isBotSignature = botSignatures.some(sig => ua.toLowerCase().includes(sig));
    const hasModernHeaders = !!(secChUa || headers['accept-language']);

    return !isBotSignature && hasModernHeaders;
}

// Engine de Proxy substituindo Axios pelo Fetch nativo do Node.js (Evita quebra no deploy da Vercel)
async function proxyContent(targetUrl, userAgent, whitePage, res) {
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,/;q=0.8',
                'Referer': whitePage,
                'Connection': 'keep-alive'
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) throw new Error(Target returned status ${response.status});
        
        const content = await response.text();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(content);
    } catch (e) {
        // Fallback seguro se a money page falhar no carregamento interno
        return fallbackWhite(whitePage, res);
    }
}

async function fallbackWhite(whitePageUrl, res) {
    try {
        const response = await fetch(whitePageUrl);
        const html = await response.text();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
    } catch (err) {
        return res.status(500).send('Service Unavailable');
    }
}

// ============================================================================
// HANDLER PRINCIPAL (VERCEL SERVERLESS)
// ============================================================================
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // Carrega a configuração local do bundle
    let config;
    try {
        const rawData = await fs.readFile(path.join(process.cwd(), 'config.json'), 'utf8');
        config = JSON.parse(rawData);
    } catch (e) {
        return res.status(500).send('Internal Configuration Error');
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // Substituídos os blocos de redirect por carregamento invisível da White Page
    if (await isMetaInfrastructure(ip) || !validateHeaders(req.headers)) {
        return await fallbackWhite(config.white_page, res);
    }

    const adId = req.query.ad_id;
    const offer = config.offers.find(o => o.ad_id === adId && o.status === 'active');

    if (!offer) {
        return await fallbackWhite(config.white_page, res);
    }

    // Validação flexível do token vindo do payload do front-end
    const token = req.body?.trust_token || req.headers['x-client-integrity-payload'];
    if (!token) {
        return await fallbackWhite(config.white_page, res);
    }

    // Executa a renderização por Proxy Reverso do lado do servidor
    return await proxyContent(offer.money_url, req.headers['user-agent'], config.white_page, res);
}

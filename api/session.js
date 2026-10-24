import dns from 'node:dns';
import net from 'node:net';

// 1. SEU TOKEN DO IPINFO AQUI
const IPINFO_TOKEN = "SEU_TOKEN_AQUI";

// 2. CONFIGURAÇÃO DIRETA (Evita erro 500 de arquivo não encontrado na Vercel)
const CONFIG = {
    offers: [
        {
            ad_id: "criativo_01",
            country: "MX",
            money_url: "https://LINK-DA-SUA-PAGINA-DE-VENDAS-MEXICO.com",
            status: "active"
        },
        {
            ad_id: "criativo_02",
            country: "CL",
            money_url: "https://LINK-DA-SUA-PAGINA-DE-VENDAS-CHILE.com",
            status: "active"
        }
    ],
    white_page: "https://SUA-PAGINA-WHITE-SEGURA.com"
};

const BAD_ORGS = [
    'facebook', 'meta', 'google', 'amazon', 'aws', 'microsoft', 'azure',
    'digitalocean', 'linode', 'ovh', 'hetzner', 'cloudflare', 'fastly',
    'leaseweb', 'choopa', 'datacenter', 'hosting', 'vps', 'server',
    'vultr', 'contabo', 'm247', 'datacamp', 'brightdata', 'oxylabs'
];

function extractCleanIp(req) {
    const rawHeader = req.headers['cf-connecting-ip']
        || req.headers['x-real-ip']
        || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || '';

    let ip = rawHeader.trim();
    if (ip.toLowerCase().startsWith('::ffff:')) {
        ip = ip.slice(7);
    }
    if (ip.includes(':') && net.isIPv6(ip) === false) {
        ip = ip.split(':')[0];
    }
    return net.isIP(ip) !== 0 ? ip : null;
}

async function isMetaInfrastructure(ip) {
    if (!ip) return false;
    try {
        const addresses = await dns.promises.reverse(ip);
        const host = (addresses[0] || '').toLowerCase();
        const forbiddenHosts = ['facebook.com', 'fbcdn.net', 'instagram.com', 'meta.com', 'tfbnw.net'];
        return forbiddenHosts.some(h => host.includes(h));
    } catch {
        return false;
    }
}

async function checkIpIntelligence(ip, targetCountry) {
    if (!ip || !IPINFO_TOKEN || IPINFO_TOKEN === "SEU_TOKEN_AQUI") {
        return { isBot: false, country: null };
    }

    try {
        const response = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`, {
            signal: AbortSignal.timeout(1200)
        });

        if (!response.ok) return { isBot: false, country: null };

        const data = await response.json();
        const org = (data.org || '').toLowerCase();
        const country = (data.country || '').toUpperCase();

        if (targetCountry && country !== targetCountry.toUpperCase()) {
            return { isBot: true, country };
        }

        const isDatacenter = BAD_ORGS.some(badOrg => org.includes(badOrg));
        if (isDatacenter) {
            return { isBot: true, country };
        }

        return { isBot: false, country };
    } catch {
        return { isBot: false, country: null };
    }
}

function validateHeaders(headers) {
    const ua = (headers['user-agent'] || '').toLowerCase();
    const secChUa = headers['sec-ch-ua'] || '';

    if (!ua || ua.length < 25) return false;

    const botSignatures = [
        'headless', 'puppeteer', 'playwright', 'selenium', 'python',
        'phantomjs', 'webdriver', 'curl', 'wget', 'facebookexternalhit',
        'facebot', 'adsbot', 'lighthouse'
    ];
    const isBotSignature = botSignatures.some(sig => ua.includes(sig));
    const hasModernHeaders = !!(secChUa || headers['accept-language']);

    return !isBotSignature && hasModernHeaders;
}

function injectBaseTag(html, targetUrl) {
    try {
        const origin = new URL(targetUrl).origin;
        const baseTag = `<base href="${origin}/">`;
        if (/<head[^>]*>/i.test(html)) {
            return html.replace(/(<head[^>]*>)/i, `$1\n${baseTag}`);
        }
        return `${baseTag}\n${html}`;
    } catch {
        return html;
    }
}

async function proxyContent(targetUrl, userAgent, whitePage, res) {
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Referer': whitePage,
                'Connection': 'keep-alive'
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) throw new Error(`Target returned status ${response.status}`);

        const rawHtml = await response.text();
        const finalHtml = injectBaseTag(rawHtml, targetUrl);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(finalHtml);
    } catch {
        return fallbackWhite(whitePage, res);
    }
}

async function fallbackWhite(whitePageUrl, res) {
    try {
        const response = await fetch(whitePageUrl, {
            signal: AbortSignal.timeout(5000)
        });
        const rawHtml = await response.text();
        const finalHtml = injectBaseTag(rawHtml, whitePageUrl);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(finalHtml);
    } catch {
        return res.status(500).send('Service Unavailable');
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    const ip = extractCleanIp(req);

    if (await isMetaInfrastructure(ip) || !validateHeaders(req.headers)) {
        return await fallbackWhite(CONFIG.white_page, res);
    }

    const adId = Array.isArray(req.query?.ad_id) ? req.query.ad_id[0] : req.query?.ad_id;
    const offer = CONFIG.offers.find(o => o.ad_id === adId && o.status === 'active');

    if (!offer) {
        return await fallbackWhite(CONFIG.white_page, res);
    }

    const targetCountry = offer.country ? offer.country.toUpperCase() : 'MX';

    const ipIntel = await checkIpIntelligence(ip, targetCountry);
    if (ipIntel.isBot) {
        return await fallbackWhite(CONFIG.white_page, res);
    }

    let parsedBody = req.body;
    if (typeof parsedBody === 'string') {
        try {
            parsedBody = JSON.parse(parsedBody);
        } catch {
            parsedBody = {};
        }
    }

    const token = parsedBody?.trust_token;
    if (!token) {
        return await fallbackWhite(CONFIG.white_page, res);
    }

    return await proxyContent(offer.money_url, req.headers['user-agent'], CONFIG.white_page, res);
}

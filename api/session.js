import dns from 'node:dns';
import net from 'node:net';

const IPINFO_TOKEN = "SEU_TOKEN_AQUI";

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

const ASN_FILTERS = [
    'facebook', 'meta', 'google', 'amazon', 'aws', 'microsoft', 'azure',
    'digitalocean', 'linode', 'ovh', 'hetzner', 'cloudflare', 'fastly',
    'leaseweb', 'choopa', 'datacenter', 'hosting', 'vps', 'server',
    'vultr', 'contabo', 'm247', 'datacamp', 'brightdata', 'oxylabs'
];

function resolveClientIp(req) {
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

async function verifyReverseDns(ip) {
    if (!ip) return false;
    try {
        const addresses = await dns.promises.reverse(ip);
        const host = (addresses[0] || '').toLowerCase();
        const restrictedDomains = ['facebook.com', 'fbcdn.net', 'instagram.com', 'meta.com', 'tfbnw.net'];
        return restrictedDomains.some(h => host.includes(h));
    } catch {
        return false;
    }
}

async function validateNetworkOrigin(ip, targetCountry) {
    if (!ip || !IPINFO_TOKEN || IPINFO_TOKEN === "SEU_TOKEN_AQUI") {
        return { restricted: false, country: null };
    }

    try {
        const response = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`, {
            signal: AbortSignal.timeout(1200)
        });

        if (!response.ok) return { restricted: false, country: null };

        const data = await response.json();
        const org = (data.org || '').toLowerCase();
        const country = (data.country || '').toUpperCase();

        if (targetCountry && country !== targetCountry.toUpperCase()) {
            return { restricted: true, country };
        }

        const isFilteredAsn = ASN_FILTERS.some(provider => org.includes(provider));
        if (isFilteredAsn) {
            return { restricted: true, country };
        }

        return { restricted: false, country };
    } catch {
        return { restricted: false, country: null };
    }
}

function validateRequestHeaders(headers) {
    const ua = (headers['user-agent'] || '').toLowerCase();
    const secChUa = headers['sec-ch-ua'] || '';

    if (!ua || ua.length < 25) return false;

    const crawlerTokens = [
        'headless', 'puppeteer', 'playwright', 'selenium', 'python',
        'phantomjs', 'webdriver', 'curl', 'wget', 'facebookexternalhit',
        'facebot', 'adsbot', 'lighthouse'
    ];
    const hasCrawlerToken = crawlerTokens.some(sig => ua.includes(sig));
    const hasStandardHeaders = !!(secChUa || headers['accept-language']);

    return !hasCrawlerToken && hasStandardHeaders;
}

function applyBaseUrl(html, targetUrl) {
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

async function renderUpstreamContent(targetUrl, userAgent, fallbackUrl, res) {
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Referer': fallbackUrl,
                'Connection': 'keep-alive'
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) throw new Error(`Status ${response.status}`);

        const rawHtml = await response.text();
        const finalHtml = applyBaseUrl(rawHtml, targetUrl);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(finalHtml);
    } catch {
        return renderFallbackView(fallbackUrl, res);
    }
}

async function renderFallbackView(fallbackUrl, res) {
    try {
        const response = await fetch(fallbackUrl, {
            signal: AbortSignal.timeout(5000)
        });
        const rawHtml = await response.text();
        const finalHtml = applyBaseUrl(rawHtml, fallbackUrl);

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

    const ip = resolveClientIp(req);

    if (await verifyReverseDns(ip) || !validateRequestHeaders(req.headers)) {
        return await renderFallbackView(CONFIG.white_page, res);
    }

    const adId = Array.isArray(req.query?.ad_id) ? req.query.ad_id[0] : req.query?.ad_id;
    const offer = CONFIG.offers.find(o => o.ad_id === adId && o.status === 'active');

    if (!offer) {
        return await renderFallbackView(CONFIG.white_page, res);
    }

    const targetCountry = offer.country ? offer.country.toUpperCase() : 'MX';

    const networkInfo = await validateNetworkOrigin(ip, targetCountry);
    if (networkInfo.restricted) {
        return await renderFallbackView(CONFIG.white_page, res);
    }

    let parsedBody = req.body;
    if (typeof parsedBody === 'string') {
        try {
            parsedBody = JSON.parse(parsedBody);
        } catch {
            parsedBody = {};
        }
    }

    if (parsedBody?.status !== "ready") {
        return await renderFallbackView(CONFIG.white_page, res);
    }

    return await renderUpstreamContent(offer.money_url, req.headers['user-agent'], CONFIG.white_page, res);
}

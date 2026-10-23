function assertHttpsUrl(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} deve ser uma URL HTTPS.`);
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${field} deve ser uma URL HTTPS válida.`);
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error(`${field} deve ser uma URL HTTPS sem credenciais.`);
    }

    return value;
}

function validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config.json deve conter um objeto.');
    }

    assertHttpsUrl(config.white_page, 'white_page');

    if (!Array.isArray(config.offers)) {
        throw new Error('offers deve ser uma lista.');
    }

    const ids = new Set();
    for (const [index, offer] of config.offers.entries()) {
        if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
            throw new Error(`offers[${index}] deve ser um objeto.`);
        }
        if (typeof offer.ad_id !== 'string' || !offer.ad_id.trim()) {
            throw new Error(`offers[${index}].ad_id deve ser um texto não vazio.`);
        }
        if (ids.has(offer.ad_id)) {
            throw new Error(`ad_id duplicado: ${offer.ad_id}`);
        }
        ids.add(offer.ad_id);
        assertHttpsUrl(offer.money_url, `offers[${index}].money_url`);
        if (typeof offer.status !== 'string' || !offer.status.trim()) {
            throw new Error(`offers[${index}].status deve ser um texto não vazio.`);
        }
    }

    return config;
}

async function lookupCountry(ip, options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 2500;
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal.reason);

    if (externalSignal?.aborted) {
        abortFromExternal();
    } else {
        externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    }

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Consulta de IP retornou HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data.status !== 'success' || typeof data.countryCode !== 'string' || !data.countryCode) {
            throw new Error(`Resposta inválida da consulta de IP: ${data.message || 'sem país'}`);
        }

        return data.countryCode;
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abortFromExternal);
    }
}

module.exports = { validateConfig, lookupCountry };

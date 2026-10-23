const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, lookupCountry } = require('../lib/runtime.cjs');

const config = () => ({
    white_page: 'https://example.com/info',
    offers: [{ ad_id: 'item_01', money_url: 'https://example.com/oferta', status: 'active' }]
});

test('aceita configuração válida', () => {
    const value = config();
    assert.equal(validateConfig(value), value);
});

test('rejeita URL insegura e IDs duplicados', () => {
    const insecure = config();
    insecure.white_page = 'http://example.com';
    assert.throws(() => validateConfig(insecure), /white_page/);

    const duplicated = config();
    duplicated.offers.push({ ...duplicated.offers[0] });
    assert.throws(() => validateConfig(duplicated), /duplicado/);
});

test('retorna o país de uma resposta válida', async () => {
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ status: 'success', countryCode: 'MX' })
    });
    assert.equal(await lookupCountry('203.0.113.10', { fetchImpl }), 'MX');
});

test('rejeita erro HTTP e resposta incompleta', async () => {
    await assert.rejects(
        lookupCountry('203.0.113.10', { fetchImpl: async () => ({ ok: false, status: 429 }) }),
        /HTTP 429/
    );
    await assert.rejects(
        lookupCountry('203.0.113.10', {
            fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'fail' }) })
        }),
        /Resposta inválida/
    );
});

test('interrompe uma consulta que excede o tempo limite', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });

    await assert.rejects(
        lookupCountry('203.0.113.10', { fetchImpl, timeoutMs: 10 }),
        { name: 'AbortError' }
    );
});

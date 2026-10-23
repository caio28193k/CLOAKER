import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/cloak.js';

function response() {
    const result = {};
    const res = {
        status(code) {
            result.status = code;
            return res;
        },
        send(body) {
            result.body = body;
            return res;
        },
        redirect(code, location) {
            result.status = code;
            result.location = location;
            return res;
        }
    };
    return { result, res };
}

function request(ip, ad_id) {
    return {
        query: { ad_id },
        headers: { 'x-forwarded-for': ip },
        socket: { remoteAddress: ip }
    };
}

function countryResponse(countryCode) {
    return { ok: true, json: async () => ({ status: 'success', countryCode }) };
}

test('IP local usa o destino padrão sem consultar serviço externo', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Não deveria consultar serviço externo'); };
    try {
        const { result, res } = response();
        await handler(request('127.0.0.1', 'item_01'), res);
        assert.equal(result.status, 302);
        assert.equal(result.location, 'https://SUA-PAGINA-WHITE-SEGURA.com');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('país fora da lista usa o destino padrão', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => countryResponse('BR');
    try {
        const { result, res } = response();
        await handler(request('203.0.113.10', 'criativo_01'), res);
        assert.equal(result.status, 302);
        assert.equal(result.location, 'https://SUA-PAGINA-WHITE-SEGURA.com');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('oferta ativa com ID correspondente redireciona para seu destino', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => countryResponse('MX');
    try {
        const { result, res } = response();
        await handler(request('203.0.113.10', 'criativo_01'), res);
        assert.equal(result.status, 302);
        assert.equal(result.location, 'https://LINK-DA-SUA-PAGINA-DE-VENDAS-MEXICO.com');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('falha da consulta retorna 503 e registra o motivo', async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const logs = [];
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    console.error = (...args) => logs.push(args);
    try {
        const { result, res } = response();
        await handler(request('203.0.113.10', 'criativo_01'), res);
        assert.equal(result.status, 503);
        assert.match(result.body, /temporariamente indisponível/);
        assert.equal(logs[0][0], 'GEO_LOOKUP_FAILED');
        assert.match(logs[0][1].message, /HTTP 429/);
    } finally {
        globalThis.fetch = originalFetch;
        console.error = originalError;
    }
});

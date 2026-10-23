import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/cloak.js';

function response() {
    const result = {};
    const res = {
        setHeader(name, value) {
            result.headers ??= {};
            result.headers[name] = value;
            return res;
        },
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
        method: 'GET',
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
        await handler(request('127.0.0.1', 'criativo_01'), res);
        assert.equal(result.status, 302);
        assert.equal(result.location, 'https://sua-pagina-white-segura.com/');
        assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
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
        assert.equal(result.location, 'https://sua-pagina-white-segura.com/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('oferta ativa com ID correspondente redireciona para seu destino', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => countryResponse('MX');
    try {
        const { result, res } = response();
        await handler(request('203.0.113.11', 'criativo_01'), res);
        assert.equal(result.status, 302);
        assert.equal(result.location, 'https://link-da-sua-pagina-de-vendas-mexico.com/');
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
        await handler(request('203.0.113.12', 'criativo_01'), res);
        assert.equal(result.status, 503);
        assert.match(result.body, /temporariamente indisponível/);
        assert.equal(logs[0][0], '[GEO_LOOKUP_FAILURE]');
        assert.match(logs[0][1].message, /HTTP 429/);
        assert.doesNotMatch(JSON.stringify(logs), /203\.0\.113\.12/);
    } finally {
        globalThis.fetch = originalFetch;
        console.error = originalError;
    }
});

test('requisições simultâneas do mesmo IP compartilham a consulta externa', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let releaseFetch;
    globalThis.fetch = () => {
        fetchCalls++;
        return new Promise(resolve => {
            releaseFetch = () => resolve(countryResponse('MX'));
        });
    };

    try {
        const first = response();
        const second = response();
        const firstRequest = handler(request('203.0.113.13', 'criativo_01'), first.res);
        const secondRequest = handler(request('203.0.113.13', 'criativo_01'), second.res);

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fetchCalls, 1);
        releaseFetch();
        await Promise.all([firstRequest, secondRequest]);

        assert.equal(first.result.status, 302);
        assert.equal(second.result.status, 302);
        assert.equal(first.result.location, second.result.location);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

import fs from 'node:fs';
import path from 'node:path';
import runtime from '../lib/runtime.cjs';

const { validateConfig, lookupCountry } = runtime;

export default async function handler(req, res) {
    // Carrega as configurações do arquivo config.json
    let config;
    try {
        config = validateConfig(JSON.parse(
            fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')
        ));
    } catch (e) {
        console.error('CONFIG_LOAD_ERROR', e);
        return res.status(500).send('Erro ao carregar configurações.');
    }

    const { ad_id } = req.query;

    // Captura o IP do visitante
    const ip = req.headers['x-forwarded-for']
        ? req.headers['x-forwarded-for'].split(',')[0]
        : req.socket.remoteAddress;

    // Ignora o IP local para não consultar o serviço externo
    if (ip === '::1' || ip === '127.0.0.1') {
        return res.redirect(302, config.white_page);
    }

    const lookupStartedAt = Date.now();
    try {
        const countryCode = await lookupCountry(ip);
        const allowedCountries = ['MX', 'CL', 'CO', 'PE'];

        if (allowedCountries.includes(countryCode) && ad_id) {
            const offer = config.offers.find(
                o => o.ad_id === ad_id && o.status === 'active'
            );

            if (offer) {
                return res.redirect(302, offer.money_url);
            }
        }
    } catch (error) {
        console.error('GEO_LOOKUP_FAILED', {
            name: error.name,
            message: error.message,
            duration_ms: Date.now() - lookupStartedAt
        });

        return res.status(503).send(
            'Consulta de localização temporariamente indisponível.'
        );
    }

    return res.redirect(302, config.white_page);
}

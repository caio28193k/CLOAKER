const fs = require('fs');

const path = require('path');

export default async function handler(req, res) {
    // Carrega as configurações do arquivo config.json
    let config;
    try {
        config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')
);
    } catch (e) {
        console.error('CONFIG_LOAD_ERROR', e);
        return res.status(500).send("Erro ao carregar configurações.");
    }
    const { ad_id } = req.query;
    
    // Captura o IP do visitante
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.socket.remoteAddress;

    // Ignora o IP local da própria Vercel para não dar erro de busca
    if (ip === '::1' || ip === '127.0.0.1') {
        return res.redirect(302, config.white_page);
    }

    try {
        // Faz uma consulta rápida e gratuita para identificar o país do IP
        const response = await fetch(`http://ip-api.com/json/${ip}`);
        const data = await response.json();
        const countryCode = data.countryCode; // Ex: MX, CL, CO, PE

        // Países permitidos
        const allowedCountries = ['MX', 'CL', 'CO', 'PE'];

        // Verifica se o país está na lista e se o ad_id existe no seu config.json
        if (allowedCountries.includes(countryCode) && ad_id) {
            const offer = config.offers.find(o => o.ad_id === ad_id && o.status === 'active');
            
            if (offer) {
                // Se for humano e do país certo, envia para a oferta
                return res.redirect(302, offer.money_url);
            }
        }
    } catch (error) {
        console.error("Erro na consulta de IP:", error);
    }

    // Se não passar nos filtros (Bot, país errado ou oferta inexistente), vai para a White
    res.redirect(302, config.white_page);
}

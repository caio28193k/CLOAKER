const fs = require('fs');
const geoip = require('geoip-lite');

export default async function handler(req, res) {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    const { ad_id } = req.query;
    
    // Captura o IP do usuário
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.socket.remoteAddress;
    
    // Busca a localização do IP
    const geo = geoip.lookup(ip);
    const countryCode = geo ? geo.country : "";

    // Lista de países permitidos
    const allowedCountries = ['MX', 'CL', 'CO', 'PE'];

    // Verificação: Se o país for permitido E o ad_id existir no config
    if (allowedCountries.includes(countryCode) && ad_id) {
        const offer = config.offers.find(o => o.ad_id === ad_id && o.status === 'active');
        
        if (offer) {
            return res.redirect(302, offer.money_url);
        }
    }

    // Se não for dos países permitidos ou não encontrar oferta, vai para a White
    res.redirect(302, config.white_page);
}

const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('../lib/runtime.cjs');

try {
    const configPath = path.join(__dirname, '..', 'config.json');
    const config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    const urls = [config.white_page, ...config.offers.map(offer => offer.money_url)];
    const placeholder = urls.find(url => /SUA-PAGINA|LINK-DA-SUA-PAGINA|SEU-DOMINIO/i.test(url));

    if (placeholder) {
        throw new Error(`Ainda existe uma URL provisória: ${placeholder}`);
    }

    console.log('config.json válido e sem URLs provisórias.');
} catch (error) {
    console.error('CONFIG_CHECK_FAILED:', error.message);
    process.exitCode = 1;
}

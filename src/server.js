'use strict';

// Servidor para desarrollo local. En Vercel no se usa este archivo:
// la app entra por api/index.js y los archivos de public/ los sirve el CDN.
require('dotenv').config({ quiet: true });

const os = require('node:os');
const app = require('./app');
const { prepararEsquema } = require('./db');
const { sembrarAdmin } = require('./auth');

const PUERTO = Number(process.env.PUERTO) || 3000;

function direccionesLocales() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

(async () => {
  try {
    await prepararEsquema();
    const pinInicial = await sembrarAdmin();

    app.listen(PUERTO, () => {
      console.log('\n  ┌─────────────────────────────────────────────');
      console.log('  │  Dólares por caja está funcionando');
      console.log('  ├─────────────────────────────────────────────');
      console.log(`  │  En esta computadora:  http://localhost:${PUERTO}`);
      for (const ip of direccionesLocales()) {
        console.log(`  │  En el teléfono:       http://${ip}:${PUERTO}`);
      }
      console.log('  └─────────────────────────────────────────────');
      console.log('\n  (El teléfono tiene que estar en la misma red WiFi.)');

      if (pinInicial) {
        console.log(`\n  Se creó el usuario "admin" con PIN ${pinInicial}.`);
        console.log('  Entra, ve a Ajustes, cambia ese PIN y añade las cajeras.');
      }
      if (!process.env.ANTHROPIC_API_KEY && process.env.SIMULAR_LECTURA !== '1') {
        console.warn('\n  AVISO: falta ANTHROPIC_API_KEY en el archivo .env.');
        console.warn('  Sin ella la app abre, pero no puede leer los billetes.');
      }
      console.log('');
    });
  } catch (err) {
    console.error('\n  No se pudo arrancar:\n');
    console.error('  ' + err.message + '\n');
    process.exit(1);
  }
})();

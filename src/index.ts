// Ponto de entrada: sobe o servidor web, conecta no banco e liga o coletor da live.

import Fastify from 'fastify';
import { config } from './config.js';
import { dbPing, pool, waitForDb } from './db.js';
import { LiveCollector } from './live/collector.js';
import { errorInfo, log } from './log.js';

const app = Fastify({ logger: false, trustProxy: true });
const startedAt = new Date();

const collector = new LiveCollector({
  username: config.tiktokUsername,
  signApiKey: config.eulerApiKey,
});

collector.on('gift', (g) => {
  // Etapa 3: aqui o presente será gravado no banco.
  log.info('presente recebido', {
    userId: g.userId, uniqueId: g.uniqueId, gift: g.giftName, qtd: g.quantity, moedas: g.coinsTotal,
  });
});

// Usado pelo Docker/Swarm para saber se o container está saudável.
app.get('/healthz', async (_req, reply) => {
  const ok = await dbPing();
  reply.code(ok ? 200 : 503).type('text/plain').header('cache-control', 'no-store');
  return ok ? 'ok' : 'banco indisponivel';
});

// Estado do serviço, em JSON.
app.get('/api/status', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return {
    servico: 'online',
    iniciadoEm: startedAt.toISOString(),
    banco: (await dbPing()) ? 'ok' : 'indisponivel',
    live: {
      usuario: `@${config.tiktokUsername}`,
      status: collector.status,
      conectadoDesde: collector.connectedSince?.toISOString() ?? null,
      ultimoPresente: collector.lastGiftAt?.toISOString() ?? null,
    },
  };
});

// Página provisória até a Etapa 4.
app.get('/', async (_req, reply) => {
  reply.type('text/html; charset=utf-8');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Ranking @${config.tiktokUsername}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f2f2f2;
font-family:system-ui,sans-serif;text-align:center}h1{color:#ff6a00;text-transform:uppercase;letter-spacing:.06em}</style>
</head><body><main><h1>Ranking @${config.tiktokUsername}</h1><p>Em construção.</p></main></body></html>`;
});

async function main() {
  await waitForDb();
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info('servidor no ar', { port: config.port, live: config.tiktokUsername });
  if (config.collectorEnabled) collector.start();
  else log.warn('coletor desligado (COLLECTOR_ENABLED=false)');
}

// Desligamento limpo quando o Portainer/Swarm para ou atualiza o container.
async function shutdown(signal: string) {
  log.info('desligando', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await collector.stop();
    await app.close();
    await pool.end();
  } catch (err) {
    log.error('erro ao desligar', errorInfo(err));
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.error('falha ao iniciar', errorInfo(err));
  process.exit(1);
});

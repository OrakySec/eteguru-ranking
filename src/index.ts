// Ponto de entrada: sobe o servidor web, prepara o banco e liga o coletor da live.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { dbPing, pool, waitForDb } from './db.js';
import { migrate } from './migrations.js';
import { LiveCollector, type CollectorStatus } from './live/collector.js';
import type { GiftEvent } from './live/gift.js';
import { SseHub } from './realtime.js';
import { currentMonth, getRanking, isValidMonth, logConnection, saveGift, type Ranking } from './store.js';
import { errorInfo, log } from './log.js';

const app = Fastify({ logger: false, trustProxy: true });
const startedAt = new Date();
const hub = new SseHub();

const collector = new LiveCollector({
  username: config.tiktokUsername,
  signApiKey: config.eulerApiKey,
});

// ---------- Ranking do mês atual em memória (recalculado quando chega presente) ----------

let cached: Ranking | null = null;
let cachedMonth = '';
let refreshTimer: NodeJS.Timeout | null = null;

async function refreshRanking(): Promise<Ranking> {
  cachedMonth = currentMonth();
  cached = await getRanking({ month: cachedMonth });
  return cached;
}

/** Junta vários presentes seguidos numa única atualização (no máximo 1 por segundo). */
function scheduleRankingBroadcast() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      hub.broadcast('ranking', await refreshRanking());
    } catch (err) {
      log.error('erro ao recalcular ranking', errorInfo(err));
    }
  }, 1_000);
}

// Virada do mês: no dia 1 à meia-noite o ranking recomeça sozinho.
setInterval(() => {
  if (cachedMonth && currentMonth() !== cachedMonth) {
    log.info('virada do mês', { de: cachedMonth, para: currentMonth() });
    scheduleRankingBroadcast();
  }
}, 30_000).unref();

function liveInfo() {
  return { aoVivo: collector.status === 'conectado', usuario: `@${config.tiktokUsername}` };
}

// ---------- Eventos da live ----------

async function onGift(g: GiftEvent) {
  try {
    const isNew = await saveGift(g, config.tiktokUsername);
    log.info(isNew ? 'presente gravado' : 'presente duplicado ignorado', {
      userId: g.userId, uniqueId: g.uniqueId, presente: g.giftName, qtd: g.quantity, moedas: g.coinsTotal,
      para: g.toUniqueId ?? 'anfitriao',
    });
    if (isNew) scheduleRankingBroadcast();
  } catch (err) {
    // Se o banco falhar, o presente fica registrado no log com todos os dados para correção manual.
    log.error('ERRO AO GRAVAR PRESENTE', { ...errorInfo(err), presente: g });
  }
}

collector.on('gift', (g) => void onGift(g));
collector.on('status', (s: CollectorStatus, detail?: string) => {
  logConnection(s, detail).catch((err) => log.warn('falha ao gravar histórico da conexão', errorInfo(err)));
  hub.broadcast('live', liveInfo());
});

// ---------- Rotas ----------

// Usado pelo Docker/Swarm para saber se o container está saudável.
app.get('/healthz', async (_req, reply) => {
  const ok = await dbPing();
  reply.code(ok ? 200 : 503).type('text/plain').header('cache-control', 'no-store');
  return ok ? 'ok' : 'banco indisponivel';
});

app.get('/api/status', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return {
    servico: 'online',
    iniciadoEm: startedAt.toISOString(),
    banco: (await dbPing()) ? 'ok' : 'indisponivel',
    conexoesTempoReal: hub.size,
    live: {
      usuario: `@${config.tiktokUsername}`,
      status: collector.status,
      conectadoDesde: collector.connectedSince?.toISOString() ?? null,
      ultimoPresente: collector.lastGiftAt?.toISOString() ?? null,
    },
  };
});

// Ranking: /api/ranking (mês atual), /api/ranking?mes=2026-12 ou /api/ranking?periodo=30d
app.get<{ Querystring: { mes?: string; periodo?: string } }>('/api/ranking', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const { mes, periodo } = req.query;
  if (periodo === '30d') return getRanking({ last30d: true });
  if (mes && mes !== currentMonth()) {
    if (!isValidMonth(mes)) return reply.code(400).send({ erro: 'mes deve estar no formato AAAA-MM' });
    return getRanking({ month: mes });
  }
  return cached && cachedMonth === currentMonth() ? cached : refreshRanking();
});

// Tempo real: o navegador fica conectado aqui e recebe o ranking a cada mudança.
app.get('/api/stream', async (req, reply) => {
  const ranking = cached && cachedMonth === currentMonth() ? cached : await refreshRanking();
  hub.handle(req, reply, [
    { event: 'ranking', data: ranking },
    { event: 'live', data: liveInfo() },
  ]);
});

// Ferramenta de teste local: simula um presente. NUNCA fica ativa em produção.
if (process.env.NODE_ENV !== 'production' && process.env.DEV_TOOLS === 'true') {
  log.warn('ferramentas de teste ATIVAS (/api/dev/presente)');
  app.post<{ Body: { id?: string; nome?: string; presente?: string; moedas?: number; qtd?: number } }>(
    '/api/dev/presente',
    async (req) => {
      const b = req.body ?? {};
      const qtd = Number(b.qtd ?? 1);
      const moedas = Number(b.moedas ?? 1);
      const id = String(b.id ?? Math.floor(Math.random() * 1e9));
      const g: GiftEvent = {
        eventKey: `dev:${id}:${Date.now()}:${Math.random()}`,
        userId: `dev${id}`, uniqueId: `teste_${id}`, nickname: b.nome ?? `Teste ${id}`,
        giftId: '0', giftName: b.presente ?? 'Rose', coinsEach: moedas, quantity: qtd, coinsTotal: moedas * qtd,
        toUserId: null, toUniqueId: null, sentAt: new Date(),
      };
      await onGift(g);
      return { ok: true, presente: g };
    },
  );
}

// Site público (arquivos da pasta public/).
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../public', import.meta.url)),
  index: ['index.html'],
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
  },
});

// ---------- Subida e desligamento ----------

async function main() {
  await waitForDb();
  await migrate();
  await refreshRanking();
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info('servidor no ar', { port: config.port, live: config.tiktokUsername });
  if (config.collectorEnabled) collector.start();
  else log.warn('coletor desligado (COLLECTOR_ENABLED=false)');
}

async function shutdown(signal: string) {
  log.info('desligando', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await collector.stop();
    hub.close();
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

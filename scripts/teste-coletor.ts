// Teste da Etapa 1: conecta numa live e mostra no terminal cada presente contado.
// Uso: npx tsx scripts/teste-coletor.ts <@usuario> [minutos]
// Grava também os eventos brutos em tmp/amostras.jsonl para conferência.

import { mkdirSync, appendFileSync } from 'node:fs';
import { LiveCollector } from '../src/live/collector.js';

const username = process.argv[2];
const minutes = Number(process.argv[3] ?? 3);
if (!username) {
  console.error('Uso: npx tsx scripts/teste-coletor.ts <@usuario> [minutos]');
  process.exit(1);
}

mkdirSync('tmp', { recursive: true });
const totals = new Map<string, { nome: string; arroba: string; moedas: number; presentes: number }>();
let streakEvents = 0;

const c = new LiveCollector({ username, signApiKey: process.env.EULER_API_KEY, offlinePollMs: 30_000 });

c.on('streak', () => { streakEvents++; });
c.on('gift', (g) => {
  appendFileSync('tmp/amostras.jsonl', JSON.stringify(g) + '\n');
  const t = totals.get(g.userId) ?? { nome: g.nickname, arroba: g.uniqueId, moedas: 0, presentes: 0 };
  t.moedas += g.coinsTotal;
  t.presentes += 1;
  totals.set(g.userId, t);
  console.log(
    `PRESENTE  ${g.nickname} (@${g.uniqueId}, id ${g.userId})  ${g.quantity}x ${g.giftName} ` +
    `(${g.coinsEach} moedas cada) = ${g.coinsTotal} moedas  para @${g.toUniqueId ?? 'anfitrião'}`,
  );
});
c.on('status', (s, d) => {
  if (s === 'aguardando-live') console.log(`>> @${username.replace(/^@/, '')} não está ao vivo agora (${d ?? 'offline'}).`);
});

c.start();

setTimeout(async () => {
  await c.stop();
  console.log('\n===== RESUMO DO TESTE =====');
  console.log(`Eventos de sequência em andamento descartados (não contados): ${streakEvents}`);
  const rank = [...totals.values()].sort((a, b) => b.moedas - a.moedas);
  rank.slice(0, 10).forEach((r, i) => console.log(`${i + 1}. ${r.nome} (@${r.arroba})  ${r.moedas} moedas em ${r.presentes} presentes`));
  if (rank.length === 0) console.log('Nenhum presente recebido no período.');
  process.exit(0);
}, minutes * 60_000);

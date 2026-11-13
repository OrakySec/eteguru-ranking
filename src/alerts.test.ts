// Simula a conexão com a live mudando de estado e confere quais alertas
// seriam enviados ao Telegram (o envio real é trocado por uma função falsa).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.TELEGRAM_BOT_TOKEN = 'token-de-teste';
process.env.TELEGRAM_CHAT_ID = '123';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1'; // sem banco: as consultas falham rápido e o alerta usa o texto padrão
process.env.DB_PASSWORD = 'x';

const sent: string[] = [];
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  sent.push(JSON.parse(init.body).text);
  return new Response(JSON.stringify({ ok: true, result: {} }));
}) as unknown as typeof fetch;

const { wireAlerts } = await import('./alerts.js');
const { pool } = await import('./db.js');

class FakeCollector extends EventEmitter {
  status = 'aguardando-live';
  set(s: string, detail?: string) { this.status = s; this.emit('status', s, detail); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  sent.length = 0;
  const c = new FakeCollector();
  wireAlerts(c as never, { dropGraceMs: 80 });
  return c;
}

test('live começou: avisa que está contando', async () => {
  const c = setup();
  c.set('conectado');
  await wait(150);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /live @eteguru detectada/);
});

test('queda rápida que volta sozinha: não incomoda', async () => {
  const c = setup();
  c.set('conectado'); await wait(50); sent.length = 0;
  c.set('reconectando', 'código 1006');
  await wait(20);
  c.set('conectado');
  await wait(200);
  assert.deepEqual(sent, []);
});

test('queda que não volta em 1 minuto: alerta, e avisa quando reconectar', async () => {
  const c = setup();
  c.set('conectado'); await wait(50); sent.length = 0;
  c.set('reconectando', 'código 1006');
  await wait(200);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /caiu/);
  c.set('conectado');
  await wait(100);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /reconectado/);
});

test('erro seguido ao conectar: alerta de problema', async () => {
  const c = setup();
  c.emit('trouble', 'SignatureRateLimitError');
  await wait(100);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /não consigo conectar/);
});

test('live encerrada: manda resumo', async () => {
  const c = setup();
  c.set('conectado'); await wait(50); sent.length = 0;
  c.set('aguardando-live', 'live encerrada');
  await wait(300);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /live encerrada/);
});

test.after(async () => { await pool.end().catch(() => {}); });

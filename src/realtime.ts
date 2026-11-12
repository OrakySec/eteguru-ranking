// Atualização em tempo real por SSE (Server-Sent Events).
// Cada visitante abre uma conexão que fica aberta; quando chega presente novo,
// o servidor manda o ranking atualizado para todos. Um "ping" a cada 20s mantém
// a conexão viva através do Traefik e das redes de celular.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { log } from './log.js';

const HEARTBEAT_MS = 20_000;
const MAX_CLIENTS = 2_000;

export class SseHub {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.writeAll(': ping\n\n'), HEARTBEAT_MS);
    this.timer.unref();
  }

  get size() { return this.clients.size; }

  /** Abre a conexão SSE e já manda os eventos iniciais. */
  handle(req: FastifyRequest, reply: FastifyReply, initial: { event: string; data: unknown }[]) {
    if (this.clients.size >= MAX_CLIENTS) {
      reply.code(503).send('muitas conexoes');
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Se a conexão cair, o navegador tenta de novo em 3 segundos.
    res.write('retry: 3000\n\n');
    for (const m of initial) res.write(format(m.event, m.data));
    this.clients.add(res);
    req.raw.on('close', () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown) {
    this.writeAll(format(event, data));
  }

  private writeAll(chunk: string) {
    for (const res of this.clients) {
      try { res.write(chunk); } catch { this.clients.delete(res); }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const res of this.clients) { try { res.end(); } catch { /* ignora */ } }
    this.clients.clear();
    log.info('conexões em tempo real encerradas');
  }
}

function format(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Mantém a conexão com a live sempre que ela estiver no ar.
// Fica num ciclo: confere se a live está no ar, conecta, escuta presentes e,
// se a conexão cair, tenta de novo com espera crescente (para não ser bloqueado).
// Toda a dependência da biblioteca do TikTok fica neste arquivo: se um dia ela
// quebrar, trocamos só aqui.

import { EventEmitter } from 'node:events';
import {
  ControlEvent,
  TikTokLiveConnection,
  UserOfflineError,
  WebcastEvent,
} from 'tiktok-live-connector';
import { decideGift, type GiftEvent, type RawGiftMessage } from './gift.js';
import { errorInfo, log } from '../log.js';

export type CollectorStatus = 'parado' | 'aguardando-live' | 'conectando' | 'conectado' | 'reconectando';

export interface CollectorOptions {
  /** @ da live, com ou sem o arroba. */
  username: string;
  /** Chave da Euler Stream (opcional, aumenta o limite gratuito). */
  signApiKey?: string;
  /** De quanto em quanto tempo conferir se a live começou (ms). */
  offlinePollMs?: number;
}

export interface CollectorEvents {
  gift: [GiftEvent];
  streak: [GiftEvent];
  status: [CollectorStatus, string?];
  /** Não consegue conectar há vários minutos por erro (não por live offline). */
  trouble: [string];
}

/** Sem receber nada do TikTok por esse tempo, a conexão é considerada travada. */
const STALL_MS = 5 * 60_000;
/** Erros seguidos por esse tempo disparam o alerta de problema. */
const TROUBLE_MS = 3 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class LiveCollector extends EventEmitter<CollectorEvents> {
  private readonly username: string;
  private readonly signApiKey?: string;
  private readonly offlinePollMs: number;
  private abort = new AbortController();
  private conn: TikTokLiveConnection | null = null;
  private _status: CollectorStatus = 'parado';
  private _lastGiftAt: Date | null = null;
  private _connectedSince: Date | null = null;

  constructor(opts: CollectorOptions) {
    super();
    this.username = opts.username.replace(/^@/, '').trim();
    this.signApiKey = opts.signApiKey || undefined;
    this.offlinePollMs = opts.offlinePollMs ?? 120_000;
  }

  get status() { return this._status; }
  get lastGiftAt() { return this._lastGiftAt; }
  get connectedSince() { return this._connectedSince; }

  private setStatus(s: CollectorStatus, detail?: string) {
    if (s === this._status) return;
    this._status = s;
    this._connectedSince = s === 'conectado' ? new Date() : null;
    log.info('status da conexão', { status: s, detail });
    this.emit('status', s, detail);
  }

  /** Inicia o ciclo. Não trava: roda em segundo plano até stop(). */
  start() {
    if (this._status !== 'parado') return;
    this.abort = new AbortController();
    void this.loop();
  }

  async stop() {
    this.abort.abort();
    try { await this.conn?.disconnect(); } catch { /* já estava fechado */ }
    this.conn = null;
    this.setStatus('parado');
  }

  private async loop() {
    const signal = this.abort.signal;
    let retryMs = 5_000;
    let wasConnected = false;

    let errorSince = 0;
    let troubleSent = false;

    while (!signal.aborted) {
      // Enquanto espera a live começar, não fica alternando o status a cada checagem.
      if (this._status !== 'aguardando-live') this.setStatus(wasConnected ? 'reconectando' : 'conectando');
      const result = await this.runOnce(signal);
      if (signal.aborted) break;
      if (result.kind !== 'error') { errorSince = 0; troubleSent = false; }

      switch (result.kind) {
        case 'offline':
          // Live fora do ar: espera e confere de novo. Não é erro.
          wasConnected = false;
          retryMs = 5_000;
          this.setStatus('aguardando-live');
          await sleep(this.offlinePollMs, signal);
          break;
        case 'stream-end':
          // Você encerrou a live normalmente.
          wasConnected = false;
          retryMs = 5_000;
          this.setStatus('aguardando-live', 'live encerrada');
          await sleep(30_000, signal);
          break;
        case 'dropped':
          // Caiu no meio da live: tenta voltar rápido, depois vai espaçando.
          wasConnected = true;
          this.setStatus('reconectando', result.detail);
          await sleep(retryMs, signal);
          retryMs = Math.min(retryMs * 2, 60_000);
          break;
        case 'error':
          log.warn('falha ao conectar', { detail: result.detail });
          if (!errorSince) errorSince = Date.now();
          if (!troubleSent && Date.now() - errorSince >= TROUBLE_MS) {
            troubleSent = true;
            this.emit('trouble', result.detail);
          }
          await sleep(retryMs, signal);
          retryMs = Math.min(retryMs * 2, 120_000);
          break;
      }
    }
  }

  /** Uma tentativa completa: conecta e espera até a conexão terminar. */
  private runOnce(signal: AbortSignal): Promise<
    { kind: 'offline' } | { kind: 'stream-end' } | { kind: 'dropped'; detail: string } | { kind: 'error'; detail: string }
  > {
    return new Promise((resolve) => {
      const conn = new TikTokLiveConnection(this.username, {
        signApiKey: this.signApiKey,
        // Não reprocessa mensagens antigas ao reconectar (evita contar presente velho de novo).
        processInitialData: false,
        enableExtendedGiftInfo: false,
      });
      this.conn = conn;
      let ended = false;
      let settled = false;
      let lastDataAt = Date.now();
      let watchdog: NodeJS.Timeout | null = null;
      const finish = (r: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearInterval(watchdog);
        conn.removeAllListeners();
        if (this.conn === conn) this.conn = null;
        resolve(r);
      };

      // Vigia: se a conexão parece aberta mas nada chega do TikTok por 5 minutos,
      // ela travou em silêncio. Fecha e reconecta.
      conn.on(ControlEvent.WEBSOCKET_DATA, () => { lastDataAt = Date.now(); });
      conn.on(WebcastEvent.GIFT, (msg) => this.handleGift(msg as unknown as RawGiftMessage));
      conn.on(WebcastEvent.STREAM_END, () => { ended = true; });
      conn.on(ControlEvent.ERROR, (err) => log.warn('erro na conexão', errorInfo(err)));
      conn.on(ControlEvent.DISCONNECTED, (ev) => {
        finish(ended ? { kind: 'stream-end' } : { kind: 'dropped', detail: `código ${ev?.code ?? '?'} ${ev?.reason ?? ''}`.trim() });
      });
      signal.addEventListener('abort', () => finish({ kind: 'error', detail: 'parado' }), { once: true });

      conn.connect()
        .then((state) => {
          if (settled) return;
          this.setStatus('conectado', `sala ${state.roomId}`);
          lastDataAt = Date.now();
          watchdog = setInterval(() => {
            if (Date.now() - lastDataAt < STALL_MS) return;
            log.warn('conexão travada: nada recebido do TikTok há 5 minutos, reconectando');
            finish({ kind: 'dropped', detail: 'conexão travada (sem dados)' });
            conn.disconnect().catch(() => { /* já fechada */ });
          }, 30_000);
        })
        .catch((err) => {
          if (err instanceof UserOfflineError) finish({ kind: 'offline' });
          else finish({ kind: 'error', detail: errorInfo(err).detail as string ?? String(err) });
        });
    });
  }

  private handleGift(msg: RawGiftMessage) {
    const d = decideGift(msg);
    if (d.kind === 'count') {
      this._lastGiftAt = new Date();
      this.emit('gift', d.event);
    } else if (d.kind === 'streak-in-progress') {
      this.emit('streak', d.preview);
    } else {
      log.warn('presente ignorado', { reason: d.reason });
    }
  }
}

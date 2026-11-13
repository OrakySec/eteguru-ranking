// Alertas no Telegram: queda da conexão durante a live, erro persistente,
// início e fim da live (com resumo) e reinício do serviço.
// O token do bot fica só na variável TELEGRAM_BOT_TOKEN; o chat é vinculado pelo painel.

import { pool } from './db.js';
import { config } from './config.js';
import type { CollectorStatus, LiveCollector } from './live/collector.js';
import { currentMonth, getRanking } from './store.js';
import { errorInfo, log } from './log.js';

const API = 'https://api.telegram.org/bot';
/** Tempo de tolerância antes de avisar uma queda (quedas rápidas se resolvem sozinhas). */
const DEFAULT_DROP_GRACE_MS = 60_000;

export interface TelegramSettings { chatId: string; nome: string; avisarInicioFim: boolean }

export const telegramConfigured = () => !!config.telegramToken;

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  // Nunca registra a URL (ela contém o token).
  if (!data.ok) throw new Error(`Telegram recusou: ${data.description ?? res.status}`);
  return data.result as T;
}

export async function getTelegramSettings(): Promise<TelegramSettings | null> {
  const envChat = config.telegramChatId;
  let saved: TelegramSettings | null = null;
  try {
    const { rows } = await pool.query<{ value: TelegramSettings }>(`select value from settings where key = 'telegram'`);
    saved = rows[0]?.value ?? null;
  } catch (err) {
    if (!envChat) throw err;
  }
  if (envChat) return { chatId: envChat, nome: saved?.nome ?? 'definido na variável', avisarInicioFim: saved?.avisarInicioFim ?? true };
  return saved;
}

export async function saveTelegramSettings(s: TelegramSettings) {
  await pool.query(
    `insert into settings (key, value) values ('telegram', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`, [s]);
}

/** Procura a última pessoa que mandou mensagem para o bot (para vincular o chat). */
export async function findLatestChat(): Promise<{ chatId: string; nome: string } | null> {
  const updates = await tg<{ message?: { chat: { id: number; type: string; first_name?: string; username?: string; title?: string } } }[]>(
    'getUpdates', { limit: 20, allowed_updates: ['message'] });
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat;
    if (chat && chat.type === 'private') {
      return { chatId: String(chat.id), nome: chat.first_name ?? chat.username ?? 'chat ' + chat.id };
    }
  }
  return null;
}

/** Envia uma mensagem. Tenta 3 vezes; se não der, só registra no log (não derruba nada). */
export async function sendAlert(text: string, chatId?: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
  const target = chatId ?? (await getTelegramSettings().catch(() => null))?.chatId;
  if (!target) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await tg('sendMessage', { chat_id: target, text, disable_web_page_preview: true });
      log.info('alerta enviado no Telegram', { texto: text.slice(0, 80) });
      return true;
    } catch (err) {
      log.warn('falha ao enviar alerta no Telegram', { tentativa: attempt, ...errorInfo(err) });
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  return false;
}

const fmt = new Intl.NumberFormat('pt-BR');
const hora = (d: Date) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

type CollectorLike = Pick<LiveCollector, 'on' | 'status'>;

/** Liga os alertas aos eventos do coletor. */
export function wireAlerts(collector: CollectorLike, opts: { dropGraceMs?: number } = {}) {
  const DROP_GRACE_MS = opts.dropGraceMs ?? DEFAULT_DROP_GRACE_MS;
  let dropTimer: NodeJS.Timeout | null = null;
  let dropAlerted = false;
  let troubleAlerted = false;
  let sessionStart: Date | null = null;
  let prev: CollectorStatus = collector.status;

  const avisarInicioFim = async () => (await getTelegramSettings().catch(() => null))?.avisarInicioFim !== false;
  const site = `https://${config.siteDomain || 'ranking'}`;

  collector.on('trouble', (detail) => {
    troubleAlerted = true;
    void sendAlert(
      `🚨 RANKING: não consigo conectar na live @${config.tiktokUsername} há 3 minutos.\n` +
      `Erro: ${detail}\n` +
      `Se você está ao vivo agora, os presentes NÃO estão sendo contados. O sistema continua tentando.`);
  });

  collector.on('status', (s, detail) => {
    const before = prev;
    prev = s;

    if (s === 'conectado') {
      if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
      if (dropAlerted || troubleAlerted) {
        void sendAlert(`✅ RANKING: reconectado na live às ${hora(new Date())}. Presentes voltaram a ser contados.`);
      } else if (before !== 'reconectando') {
        sessionStart = new Date();
        void avisarInicioFim().then((ok) => ok && sendAlert(
          `🟠 RANKING: live @${config.tiktokUsername} detectada às ${hora(sessionStart!)}. Contando presentes.\n${site}`));
      }
      dropAlerted = false;
      troubleAlerted = false;
      return;
    }

    if (s === 'reconectando' && before === 'conectado') {
      // Espera 1 minuto: a maioria das quedas volta sozinha em segundos.
      if (dropTimer) clearTimeout(dropTimer);
      dropTimer = setTimeout(() => {
        dropTimer = null;
        if (collector.status === 'conectado') return;
        dropAlerted = true;
        void sendAlert(
          `⚠️ RANKING: a conexão com a live caiu às ${hora(new Date(Date.now() - DROP_GRACE_MS))} e ainda não voltou (${detail ?? 'sem detalhe'}).\n` +
          `Tentando reconectar. Presentes enviados nesse intervalo podem não ser contados: confira no ranking oficial.`);
      }, DROP_GRACE_MS);
      return;
    }

    if (s === 'aguardando-live') {
      if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
      const start = sessionStart;
      sessionStart = null;
      if (dropAlerted) {
        dropAlerted = false;
        void sendAlert('ℹ️ RANKING: a live não está mais no ar. Parei de tentar reconectar.');
        return;
      }
      if (start && (before === 'conectado' || before === 'reconectando')) {
        void avisarInicioFim().then(async (ok) => {
          if (!ok) return;
          void sendAlert(await liveSummary(start));
        });
      }
    }
  });
}

async function liveSummary(start: Date): Promise<string> {
  try {
    const { rows } = await pool.query<{ n: string; moedas: string; pessoas: string }>(
      `select count(*) as n, coalesce(sum(coins_total), 0) as moedas, count(distinct user_id) as pessoas
         from gift_events where to_host and received_at >= $1`, [start]);
    const r = rows[0];
    const rk = await getRanking({ month: currentMonth(), limit: 1 });
    const lider = rk.top[0] ? `${rk.top[0].nome} (${fmt.format(rk.top[0].moedas)} moedas)` : 'ninguém ainda';
    return `⏹ RANKING: live encerrada às ${hora(new Date())}.\n` +
      `Nesta live: ${fmt.format(Number(r.n))} presentes, ${fmt.format(Number(r.moedas))} moedas, ${r.pessoas} pessoas.\n` +
      `Líder do mês: ${lider}.`;
  } catch {
    return `⏹ RANKING: live encerrada às ${hora(new Date())}.`;
  }
}

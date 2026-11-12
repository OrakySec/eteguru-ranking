// Leitura e gravação no banco: presentes, histórico da conexão e ranking.

import { createHash } from 'node:crypto';
import { pool } from './db.js';
import type { GiftEvent } from './live/gift.js';

export const TZ = 'America/Sao_Paulo';

/** Grava o presente. Devolve false se ele já estava gravado (duplicado). */
export async function saveGift(g: GiftEvent, hostUsername: string): Promise<boolean> {
  const toHost = !g.toUniqueId || g.toUniqueId.toLowerCase() === hostUsername.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into viewers (user_id, unique_id, nickname, last_seen_at)
       values ($1, $2, $3, now())
       on conflict (user_id) do update
         set unique_id = excluded.unique_id, nickname = excluded.nickname, last_seen_at = now()`,
      [g.userId, g.uniqueId, g.nickname],
    );
    const r = await client.query(
      `insert into gift_events (event_key, user_id, unique_id, nickname, gift_id, gift_name,
         coins_each, quantity, coins_total, to_user_id, to_unique_id, to_host, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (event_key) do nothing`,
      [g.eventKey, g.userId, g.uniqueId, g.nickname, g.giftId, g.giftName,
        g.coinsEach, g.quantity, g.coinsTotal, g.toUserId, g.toUniqueId, toHost, g.sentAt],
    );
    await client.query('commit');
    return r.rowCount === 1;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function logConnection(status: string, detail?: string) {
  await pool.query('insert into connection_log (status, detail) values ($1, $2)', [status, detail ?? null]);
}

/** Mês atual no horário de Brasília, formato AAAA-MM. */
export function currentMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  return `${y}-${m}`;
}

export function isValidMonth(m: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

/** Código público estável da pessoa (não expõe o ID real do TikTok). */
function publicId(userId: string): string {
  return createHash('sha256').update(`eteguru:${userId}`).digest('hex').slice(0, 12);
}

export interface RankingRow {
  posicao: number;
  id: string;
  nome: string;
  moedas: number;
}

export interface Ranking {
  periodo: { tipo: 'mes' | '30dias'; mes?: string; inicio: string; fim: string };
  top: RankingRow[];
  atualizadoEm: string;
}

/**
 * Ranking por período. Soma as moedas dos presentes para você (não para convidados)
 * e as correções do painel. Pessoas escondidas ficam de fora. Empate: fica na frente
 * quem chegou primeiro naquele total.
 */
export async function getRanking(opts: { month?: string; last30d?: boolean; limit?: number }): Promise<Ranking> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  let start: Date;
  let end: Date;
  let adjustSql: string;
  let adjustParam: string | Date;
  let periodo: Ranking['periodo'];

  if (opts.last30d) {
    end = new Date();
    start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    adjustSql = 'a.created_at >= $3';
    adjustParam = start;
    periodo = { tipo: '30dias', inicio: start.toISOString(), fim: end.toISOString() };
  } else {
    const month = opts.month ?? currentMonth();
    const { rows } = await pool.query<{ s: Date; e: Date }>(
      `select (($1 || '-01')::timestamp at time zone '${TZ}') as s,
              ((($1 || '-01')::date + interval '1 month')::timestamp at time zone '${TZ}') as e`,
      [month],
    );
    start = rows[0].s;
    end = rows[0].e;
    adjustSql = 'a.month = $3';
    adjustParam = month;
    periodo = { tipo: 'mes', mes: month, inicio: start.toISOString(), fim: end.toISOString() };
  }

  const { rows } = await pool.query<{ user_id: string; nome: string; moedas: string; chegou: Date | null }>(
    `with pontos as (
       select g.user_id, g.coins_total as moedas, g.sent_at as quando
         from gift_events g
        where g.to_host and g.sent_at >= $1 and g.sent_at < $2
       union all
       select a.user_id, a.coins, null
         from adjustments a
        where ${adjustSql}
     )
     select v.user_id,
            coalesce(nullif(v.display_name, ''), nullif(v.nickname, ''), 'Anônimo') as nome,
            sum(p.moedas) as moedas,
            max(p.quando) as chegou
       from pontos p
       join viewers v on v.user_id = p.user_id
      where not v.hidden
      group by v.user_id, nome
     having sum(p.moedas) > 0
      order by moedas desc, chegou asc nulls last
      limit $4`,
    [start, end, adjustParam, limit],
  );

  return {
    periodo,
    top: rows.map((r, i) => ({ posicao: i + 1, id: publicId(r.user_id), nome: r.nome, moedas: Number(r.moedas) })),
    atualizadoEm: new Date().toISOString(),
  };
}

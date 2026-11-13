// Leitura e gravação no banco: presentes, histórico da conexão e ranking.

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import type { GiftEvent } from './live/gift.js';
import { log } from './log.js';

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
    await mergeManualViewer(client, g.userId, g.uniqueId);
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

/** ID provisório de quem foi cadastrado à mão pelo @ (antes do primeiro presente). */
export function manualUserId(uniqueId: string): string {
  return 'manual:' + uniqueId.replace(/^@/, '').trim().toLowerCase();
}

/**
 * Se essa pessoa tinha sido cadastrada à mão pelo @, passa as correções, as
 * entregas, o nome definido e o "escondido" para o ID real, e apaga o provisório.
 */
async function mergeManualViewer(client: PoolClient, realId: string, uniqueId: string) {
  if (!uniqueId) return;
  const manualId = manualUserId(uniqueId);
  const m = await client.query<{ display_name: string | null; hidden: boolean }>(
    'select display_name, hidden from viewers where user_id = $1 and manual', [manualId]);
  if (!m.rows[0]) return;
  await client.query('update adjustments set user_id = $1 where user_id = $2', [realId, manualId]);
  await client.query('update deliveries set user_id = $1 where user_id = $2', [realId, manualId]);
  await client.query(
    `update viewers set display_name = coalesce(nullif(display_name, ''), $2), hidden = hidden or $3 where user_id = $1`,
    [realId, m.rows[0].display_name, m.rows[0].hidden]);
  await client.query('delete from viewers where user_id = $1', [manualId]);
  await client.query(`insert into admin_log (action, details) values ('cadastro manual unido ao ID real', $1)`,
    [{ arroba: uniqueId, idReal: realId }]);
  log.info('cadastro manual unido ao ID real', { arroba: uniqueId, userId: realId });
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
  periodo: Period;
  top: RankingRow[];
  atualizadoEm: string;
}

export interface Period {
  tipo: 'mes' | '30dias';
  mes?: string;
  inicio: string;
  fim: string;
}

async function resolvePeriod(opts: { month?: string; last30d?: boolean }) {
  if (opts.last30d) {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    return {
      start, end, adjustSql: 'a.created_at >= $3', adjustParam: start as string | Date,
      periodo: { tipo: '30dias', inicio: start.toISOString(), fim: end.toISOString() } as Period,
    };
  }
  const month = opts.month ?? currentMonth();
  const { rows } = await pool.query<{ s: Date; e: Date }>(
    `select (($1 || '-01')::timestamp at time zone '${TZ}') as s,
            ((($1 || '-01')::date + interval '1 month')::timestamp at time zone '${TZ}') as e`,
    [month],
  );
  return {
    start: rows[0].s, end: rows[0].e, adjustSql: 'a.month = $3', adjustParam: month as string | Date,
    periodo: { tipo: 'mes', mes: month, inicio: rows[0].s.toISOString(), fim: rows[0].e.toISOString() } as Period,
  };
}

export interface FullRankingRow {
  user_id: string;
  unique_id: string;
  nickname: string;
  display_name: string | null;
  hidden: boolean;
  manual: boolean;
  nome: string;
  moedas: number;
  presentes: number;
  correcoes: number;
}

/**
 * Soma as moedas dos presentes para você (não para convidados) e as correções do
 * painel, no período. Empate: fica na frente quem chegou primeiro naquele total.
 */
async function rankingQuery(opts: { month?: string; last30d?: boolean; limit: number; includeHidden: boolean }) {
  const p = await resolvePeriod(opts);
  const { rows } = await pool.query<FullRankingRow & { moedas: string; presentes: string; correcoes: string }>(
    `with pontos as (
       select g.user_id, g.coins_total as moedas, g.sent_at as quando, 1 as presente, 0 as correcao
         from gift_events g
        where g.to_host and g.sent_at >= $1 and g.sent_at < $2
       union all
       select a.user_id, a.coins, null, 0, a.coins
         from adjustments a
        where ${p.adjustSql}
     )
     select v.user_id, v.unique_id, v.nickname, v.display_name, v.hidden, v.manual,
            coalesce(nullif(v.display_name, ''), nullif(v.nickname, ''), 'Anônimo') as nome,
            sum(pt.moedas) as moedas,
            sum(pt.presente) as presentes,
            sum(pt.correcao) as correcoes,
            max(pt.quando) as chegou
       from pontos pt
       join viewers v on v.user_id = pt.user_id
      where ($5 or not v.hidden)
      group by v.user_id
     having sum(pt.moedas) > 0
      order by moedas desc, chegou asc nulls last
      limit $4`,
    [p.start, p.end, p.adjustParam, opts.limit, opts.includeHidden],
  );
  return {
    periodo: p.periodo,
    rows: rows.map((r) => ({ ...r, moedas: Number(r.moedas), presentes: Number(r.presentes), correcoes: Number(r.correcoes) })),
  };
}

/** Ranking público: só apelido e moedas, sem escondidos. */
export async function getRanking(opts: { month?: string; last30d?: boolean; limit?: number }): Promise<Ranking> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const { periodo, rows } = await rankingQuery({ ...opts, limit, includeHidden: false });
  return {
    periodo,
    top: rows.map((r, i) => ({ posicao: i + 1, id: publicId(r.user_id), nome: r.nome, moedas: r.moedas })),
    atualizadoEm: new Date().toISOString(),
  };
}

/** Ranking completo para o painel: inclui escondidos, @, ID e correções. */
export async function getAdminRanking(opts: { month?: string; last30d?: boolean }) {
  const { periodo, rows } = await rankingQuery({ ...opts, limit: 200, includeHidden: true });
  let pos = 0;
  return {
    periodo,
    linhas: rows.map((r) => ({ ...r, posicaoPublica: r.hidden ? null : ++pos })),
  };
}

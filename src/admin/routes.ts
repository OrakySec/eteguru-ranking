// Rotas do painel (/api/admin/...). Todas exigem login, menos o próprio login.
// Toda ação que muda algo fica registrada em admin_log.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { getSettings, type SiteSettings } from '../content.js';
import { currentMonth, getAdminRanking, isValidMonth, manualUserId } from '../store.js';
import { deleteImage, MAX_UPLOAD_BYTES, saveImage, UploadError } from '../uploads.js';
import { audit, login, logout, requireAdmin } from './auth.js';

export interface AdminDeps {
  /** Avisa que o ranking público mudou (para atualizar quem está com a página aberta). */
  rankingChanged: () => void;
  /** Avisa que prêmio, entregas ou textos mudaram. */
  siteChanged: () => void;
  liveStatus: () => { status: string; conectadoDesde: string | null; ultimoPresente: string | null; usuario: string };
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);
const cleanAt = (v: unknown) => str(v, 60).replace(/^@+/, '').toLowerCase();

class BadRequest extends Error {}

async function readImages(req: FastifyRequest, max: number): Promise<string[]> {
  const names: string[] = [];
  for await (const part of req.files({ limits: { fileSize: MAX_UPLOAD_BYTES, files: max } })) {
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new UploadError('Foto grande demais (máximo 15 MB).');
    names.push(await saveImage(buf));
  }
  if (names.length === 0) throw new UploadError('Nenhuma foto enviada.');
  return names;
}

export async function adminRoutes(app: FastifyInstance, deps: AdminDeps) {
  // ---------- Login ----------
  app.post('/api/admin/login', login);
  app.post('/api/admin/logout', logout);

  await app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);
    r.addHook('onSend', async (_req, reply) => { reply.header('cache-control', 'no-store'); });
    r.setErrorHandler((err, _req, reply) => {
      if (err instanceof BadRequest || err instanceof UploadError) return reply.code(400).send({ erro: err.message });
      const e = err as { code?: string; statusCode?: number; message?: string };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(400).send({ erro: 'Foto grande demais (máximo 15 MB).' });
      if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ erro: e.message });
      reply.log?.error?.(err);
      console.error(err);
      return reply.code(500).send({ erro: 'Erro interno. Veja os logs do container.' });
    });

    r.get('/api/admin/me', async () => ({ ok: true, mesAtual: currentMonth() }));

    // ---------- Resumo: conexão, presentes recentes ----------
    r.get('/api/admin/resumo', async () => {
      const [conexao, presentes] = await Promise.all([
        pool.query(`select at, status, detail from connection_log order by id desc limit 15`),
        pool.query(`select g.sent_at, g.user_id, g.unique_id, g.nickname, g.gift_name, g.quantity, g.coins_total, g.to_host, g.to_unique_id
                      from gift_events g order by g.id desc limit 40`),
      ]);
      return { live: deps.liveStatus(), conexao: conexao.rows, presentes: presentes.rows };
    });

    // ---------- Ranking completo ----------
    r.get<{ Querystring: { mes?: string; periodo?: string } }>('/api/admin/ranking', async (req) => {
      if (req.query.periodo === '30d') return getAdminRanking({ last30d: true });
      const mes = req.query.mes || currentMonth();
      if (!isValidMonth(mes)) throw new BadRequest('Mês inválido.');
      return getAdminRanking({ month: mes });
    });

    // ---------- Pessoas ----------
    r.get<{ Querystring: { busca?: string } }>('/api/admin/pessoas', async (req) => {
      const q = `%${str(req.query.busca, 60).replace(/^@/, '').toLowerCase()}%`;
      const { rows } = await pool.query(
        `select v.user_id, v.unique_id, v.nickname, v.display_name, v.hidden, v.manual, v.last_seen_at,
                coalesce((select sum(coins_total) from gift_events g where g.user_id = v.user_id and g.to_host), 0)::int as moedas_total
           from viewers v
          where lower(v.unique_id) like $1 or lower(v.nickname) like $1 or lower(coalesce(v.display_name, '')) like $1
          order by v.last_seen_at desc
          limit 50`,
        [q],
      );
      return rows;
    });

    // Cadastro manual pelo @ (antes da pessoa mandar o primeiro presente).
    r.post('/api/admin/pessoas', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const arroba = cleanAt(b.arroba);
      if (!/^[a-z0-9._]{2,24}$/.test(arroba)) throw new BadRequest('Digite um @ válido (letras, números, ponto ou _).');
      const apelido = str(b.apelido, 60) || arroba;
      const existing = await pool.query(`select user_id, manual from viewers where lower(unique_id) = $1 limit 1`, [arroba]);
      if (existing.rows[0]) {
        throw new BadRequest(existing.rows[0].manual
          ? 'Esse @ já foi cadastrado manualmente.'
          : 'Essa pessoa já existe no sistema (já mandou presente). Busque por ela na lista.');
      }
      const id = manualUserId(arroba);
      await pool.query(
        `insert into viewers (user_id, unique_id, nickname, manual) values ($1, $2, $3, true)`,
        [id, arroba, apelido]);
      await audit('cadastro manual', { arroba, apelido }, req.ip);
      return { ok: true, user_id: id };
    });

    r.get<{ Params: { id: string } }>('/api/admin/pessoas/:id', async (req) => {
      const id = req.params.id;
      const v = await pool.query('select * from viewers where user_id = $1', [id]);
      if (!v.rows[0]) throw new BadRequest('Pessoa não encontrada.');
      const [gifts, adj] = await Promise.all([
        pool.query(`select sent_at, gift_name, quantity, coins_total, to_host, to_unique_id
                      from gift_events where user_id = $1 order by id desc limit 50`, [id]),
        pool.query(`select id, month, coins, reason, created_at from adjustments where user_id = $1 order by id desc`, [id]),
      ]);
      return { pessoa: v.rows[0], presentes: gifts.rows, correcoes: adj.rows };
    });

    // Renomear (nome que aparece no site) e esconder/mostrar.
    r.patch<{ Params: { id: string } }>('/api/admin/pessoas/:id', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const id = req.params.id;
      const changes: Record<string, unknown> = {};
      if ('display_name' in b) {
        const name = str(b.display_name, 40);
        await pool.query('update viewers set display_name = $2 where user_id = $1', [id, name || null]);
        changes.nome = name || '(apelido do TikTok)';
      }
      if ('hidden' in b) {
        await pool.query('update viewers set hidden = $2 where user_id = $1', [id, b.hidden === true]);
        changes.escondido = b.hidden === true;
      }
      await audit('pessoa alterada', { user_id: id, ...changes }, req.ip);
      deps.rankingChanged();
      return { ok: true };
    });

    // Apagar um cadastro manual que não foi usado (sem correções nem entregas).
    r.delete<{ Params: { id: string } }>('/api/admin/pessoas/:id', async (req) => {
      const id = req.params.id;
      const v = await pool.query('select manual, unique_id from viewers where user_id = $1', [id]);
      if (!v.rows[0]?.manual) throw new BadRequest('Só dá para apagar cadastros manuais.');
      const used = await pool.query(
        `select (select count(*) from adjustments where user_id = $1) + (select count(*) from deliveries where user_id = $1) as n`, [id]);
      if (Number(used.rows[0].n) > 0) throw new BadRequest('Esse cadastro tem correções ou entregas. Apague-as antes.');
      await pool.query('delete from viewers where user_id = $1', [id]);
      await audit('cadastro manual apagado', { arroba: v.rows[0].unique_id }, req.ip);
      return { ok: true };
    });

    // ---------- Correções de pontuação ----------
    r.get<{ Querystring: { mes?: string } }>('/api/admin/correcoes', async (req) => {
      const mes = req.query.mes || currentMonth();
      const { rows } = await pool.query(
        `select a.id, a.month, a.coins, a.reason, a.created_at, a.user_id, v.unique_id,
                coalesce(nullif(v.display_name, ''), v.nickname) as nome
           from adjustments a join viewers v on v.user_id = a.user_id
          where a.month = $1 order by a.id desc`, [mes]);
      return rows;
    });

    r.post('/api/admin/correcoes', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const userId = str(b.user_id, 100);
      const mes = str(b.mes, 7) || currentMonth();
      const moedas = int(b.moedas);
      const motivo = str(b.motivo, 300);
      if (!isValidMonth(mes)) throw new BadRequest('Mês inválido.');
      if (!Number.isFinite(moedas) || moedas === 0 || Math.abs(moedas) > 100_000_000) throw new BadRequest('Informe as moedas (pode ser negativo para tirar).');
      if (motivo.length < 3) throw new BadRequest('Escreva o motivo da correção.');
      const v = await pool.query('select unique_id from viewers where user_id = $1', [userId]);
      if (!v.rows[0]) throw new BadRequest('Pessoa não encontrada.');
      const { rows } = await pool.query(
        'insert into adjustments (user_id, month, coins, reason) values ($1, $2, $3, $4) returning id',
        [userId, mes, moedas, motivo]);
      await audit('correção lançada', { id: rows[0].id, user_id: userId, arroba: v.rows[0].unique_id, mes, moedas, motivo }, req.ip);
      deps.rankingChanged();
      return { ok: true, id: rows[0].id };
    });

    r.delete<{ Params: { id: string } }>('/api/admin/correcoes/:id', async (req) => {
      const { rows } = await pool.query('delete from adjustments where id = $1 returning user_id, month, coins, reason', [int(req.params.id)]);
      if (!rows[0]) throw new BadRequest('Correção não encontrada.');
      await audit('correção apagada', { ...rows[0] }, req.ip);
      deps.rankingChanged();
      return { ok: true };
    });

    // ---------- Prêmio do mês ----------
    r.get<{ Querystring: { mes?: string } }>('/api/admin/premio', async (req) => {
      const mes = req.query.mes || currentMonth();
      if (!isValidMonth(mes)) throw new BadRequest('Mês inválido.');
      const p = await pool.query('select title, description from prizes where month = $1', [mes]);
      const imgs = await pool.query('select id, file, alt, sort from prize_images where month = $1 order by sort, id', [mes]);
      return { mes, titulo: p.rows[0]?.title ?? '', descricao: p.rows[0]?.description ?? '', imagens: imgs.rows };
    });

    r.put('/api/admin/premio', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const mes = str(b.mes, 7);
      const titulo = str(b.titulo, 80);
      const descricao = str(b.descricao, 2000);
      if (!isValidMonth(mes)) throw new BadRequest('Mês inválido.');
      if (!titulo) throw new BadRequest('Dê um nome ao prêmio.');
      await pool.query(
        `insert into prizes (month, title, description) values ($1, $2, $3)
         on conflict (month) do update set title = excluded.title, description = excluded.description, updated_at = now()`,
        [mes, titulo, descricao]);
      await audit('prêmio salvo', { mes, titulo }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    r.post<{ Params: { mes: string } }>('/api/admin/premio/:mes/imagens', async (req) => {
      const mes = req.params.mes;
      const p = await pool.query('select 1 from prizes where month = $1', [mes]);
      if (!p.rows[0]) throw new BadRequest('Salve o nome do prêmio antes de enviar fotos.');
      const names = await readImages(req, 10);
      const max = await pool.query('select coalesce(max(sort), -1) as m from prize_images where month = $1', [mes]);
      let sort = Number(max.rows[0].m);
      for (const n of names) {
        await pool.query('insert into prize_images (month, file, sort) values ($1, $2, $3)', [mes, n, ++sort]);
      }
      await audit('fotos do prêmio enviadas', { mes, quantidade: names.length }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    r.post<{ Params: { id: string } }>('/api/admin/imagens/:id/primeira', async (req) => {
      const { rows } = await pool.query('select month from prize_images where id = $1', [int(req.params.id)]);
      if (!rows[0]) throw new BadRequest('Foto não encontrada.');
      const min = await pool.query('select coalesce(min(sort), 0) as m from prize_images where month = $1', [rows[0].month]);
      await pool.query('update prize_images set sort = $2 where id = $1', [int(req.params.id), Number(min.rows[0].m) - 1]);
      deps.siteChanged();
      return { ok: true };
    });

    r.delete<{ Params: { id: string } }>('/api/admin/imagens/:id', async (req) => {
      const { rows } = await pool.query('delete from prize_images where id = $1 returning month, file', [int(req.params.id)]);
      if (!rows[0]) throw new BadRequest('Foto não encontrada.');
      await deleteImage(rows[0].file);
      await audit('foto do prêmio apagada', { mes: rows[0].month }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    // ---------- Ganhadores e entregas ----------
    r.get('/api/admin/entregas', async () => {
      const { rows } = await pool.query(
        `select id, month, user_id, winner_name, prize_title, coins, status,
                to_char(delivered_at, 'YYYY-MM-DD') as delivered_at, photo, note
           from deliveries order by month desc, id desc`);
      return rows;
    });

    const readDelivery = (b: Record<string, unknown>) => {
      const mes = str(b.mes, 7);
      const ganhador = str(b.ganhador, 40);
      const premio = str(b.premio, 80);
      const status = b.status === 'entregue' ? 'entregue' : 'aguardando';
      const entregueEm = str(b.entregue_em, 10);
      const moedas = b.moedas === '' || b.moedas == null ? null : int(b.moedas);
      if (!isValidMonth(mes)) throw new BadRequest('Mês inválido.');
      if (!ganhador) throw new BadRequest('Informe o nome do ganhador.');
      if (!premio) throw new BadRequest('Informe o prêmio.');
      if (entregueEm && !/^\d{4}-\d{2}-\d{2}$/.test(entregueEm)) throw new BadRequest('Data de entrega inválida.');
      if (moedas !== null && !Number.isFinite(moedas)) throw new BadRequest('Moedas inválidas.');
      return {
        mes, ganhador, premio, status, moedas,
        entregueEm: status === 'entregue' ? (entregueEm || new Date().toISOString().slice(0, 10)) : null,
        userId: str(b.user_id, 100) || null,
        obs: str(b.obs, 200),
      };
    };

    r.post('/api/admin/entregas', async (req) => {
      const d = readDelivery((req.body ?? {}) as Record<string, unknown>);
      const { rows } = await pool.query(
        `insert into deliveries (month, user_id, winner_name, prize_title, coins, status, delivered_at, note)
         values ($1, (select user_id from viewers where user_id = $2), $3, $4, $5, $6, $7, $8) returning id`,
        [d.mes, d.userId, d.ganhador, d.premio, d.moedas, d.status, d.entregueEm, d.obs]);
      await audit('ganhador registrado', { id: rows[0].id, mes: d.mes, ganhador: d.ganhador, premio: d.premio }, req.ip);
      deps.siteChanged();
      return { ok: true, id: rows[0].id };
    });

    r.put<{ Params: { id: string } }>('/api/admin/entregas/:id', async (req) => {
      const d = readDelivery((req.body ?? {}) as Record<string, unknown>);
      const { rowCount } = await pool.query(
        `update deliveries set month = $2, user_id = (select user_id from viewers where user_id = $3), winner_name = $4,
                prize_title = $5, coins = $6, status = $7, delivered_at = $8, note = $9 where id = $1`,
        [int(req.params.id), d.mes, d.userId, d.ganhador, d.premio, d.moedas, d.status, d.entregueEm, d.obs]);
      if (!rowCount) throw new BadRequest('Entrega não encontrada.');
      await audit('entrega alterada', { id: int(req.params.id), status: d.status, ganhador: d.ganhador }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    r.post<{ Params: { id: string } }>('/api/admin/entregas/:id/foto', async (req) => {
      const id = int(req.params.id);
      const old = await pool.query('select photo from deliveries where id = $1', [id]);
      if (!old.rows[0]) throw new BadRequest('Entrega não encontrada.');
      const [name] = await readImages(req, 1);
      await pool.query('update deliveries set photo = $2 where id = $1', [id, name]);
      await deleteImage(old.rows[0].photo);
      await audit('foto da entrega enviada', { id }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    r.delete<{ Params: { id: string } }>('/api/admin/entregas/:id', async (req) => {
      const { rows } = await pool.query('delete from deliveries where id = $1 returning month, winner_name, photo', [int(req.params.id)]);
      if (!rows[0]) throw new BadRequest('Entrega não encontrada.');
      await deleteImage(rows[0].photo);
      await audit('entrega apagada', { mes: rows[0].month, ganhador: rows[0].winner_name }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    // ---------- Textos do site: agenda, regras, privacidade ----------
    r.get('/api/admin/textos', async () => getSettings());

    r.put('/api/admin/textos', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const agenda = (Array.isArray(b.agenda) ? b.agenda : [])
        .map((a) => ({ dia: str((a as Record<string, unknown>)?.dia, 40), horario: str((a as Record<string, unknown>)?.horario, 40) }))
        .filter((a) => a.dia || a.horario)
        .slice(0, 14);
      const regras = (Array.isArray(b.regras) ? b.regras : []).map((t) => str(t, 300)).filter(Boolean).slice(0, 20);
      const privacidade = str(b.privacidade, 600);
      if (!privacidade) throw new BadRequest('O aviso de privacidade não pode ficar vazio (LGPD).');
      const value: SiteSettings = { agenda, regras, privacidade };
      await pool.query(
        `insert into settings (key, value) values ('site', $1)
         on conflict (key) do update set value = excluded.value, updated_at = now()`, [value]);
      await audit('textos do site alterados', { agenda: agenda.length, regras: regras.length }, req.ip);
      deps.siteChanged();
      return { ok: true };
    });

    // ---------- Auditoria ----------
    r.get('/api/admin/log', async () => {
      const { rows } = await pool.query('select at, action, details, ip from admin_log order by id desc limit 100');
      return rows;
    });
  });
}

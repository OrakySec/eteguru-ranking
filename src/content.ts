// Conteúdo público do site: prêmio do mês, agenda, regras e entregas.
// Tudo isso é editado no painel (Etapa 5) e lido aqui.

import { pool } from './db.js';
import { currentMonth, TZ } from './store.js';

export interface SiteSettings {
  agenda: { dia: string; horario: string }[];
  regras: string[];
  privacidade: string;
}

const DEFAULT_SETTINGS: SiteSettings = { agenda: [], regras: [], privacidade: '' };

export async function getSettings(): Promise<SiteSettings> {
  const { rows } = await pool.query<{ value: SiteSettings }>(`select value from settings where key = 'site'`);
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export const UPLOADS_URL = '/uploads/';

export interface PublicPrize {
  mes: string;
  titulo: string;
  descricao: string;
  imagens: { url: string; alt: string }[];
}

export async function getPrize(month: string): Promise<PublicPrize | null> {
  const p = await pool.query<{ title: string; description: string }>(
    'select title, description from prizes where month = $1', [month]);
  if (!p.rows[0]) return null;
  const imgs = await pool.query<{ file: string; alt: string }>(
    'select file, alt from prize_images where month = $1 order by sort, id', [month]);
  return {
    mes: month,
    titulo: p.rows[0].title,
    descricao: p.rows[0].description,
    imagens: imgs.rows.map((r) => ({ url: UPLOADS_URL + encodeURIComponent(r.file), alt: r.alt })),
  };
}

export interface PublicDelivery {
  mes: string;
  ganhador: string;
  premio: string;
  moedas: number | null;
  status: 'aguardando' | 'entregue';
  entregueEm: string | null;
  foto: string | null;
  obs: string;
}

export async function getDeliveries(limit = 24): Promise<PublicDelivery[]> {
  const { rows } = await pool.query<{
    month: string; winner_name: string; prize_title: string; coins: number | null;
    status: 'aguardando' | 'entregue'; delivered_at: string | null; photo: string | null; note: string;
  }>(
    `select month, winner_name, prize_title, coins, status,
            to_char(delivered_at, 'YYYY-MM-DD') as delivered_at, photo, note
       from deliveries order by month desc, id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    mes: r.month,
    ganhador: r.winner_name,
    premio: r.prize_title,
    moedas: r.coins,
    status: r.status,
    entregueEm: r.delivered_at,
    foto: r.photo ? UPLOADS_URL + encodeURIComponent(r.photo) : null,
    obs: r.note,
  }));
}

/** Tudo que a página pública precisa, numa chamada só. */
export async function getSiteContent() {
  const mes = currentMonth();
  const [settings, premio, entregas, fim] = await Promise.all([
    getSettings(),
    getPrize(mes),
    getDeliveries(),
    pool.query<{ e: Date }>(
      `select ((($1 || '-01')::date + interval '1 month')::timestamp at time zone '${TZ}') as e`, [mes]),
  ]);
  return {
    mes,
    fimDoMes: fim.rows[0].e.toISOString(),
    agora: new Date().toISOString(),
    premio,
    agenda: settings.agenda,
    regras: settings.regras,
    privacidade: settings.privacidade,
    entregas,
  };
}

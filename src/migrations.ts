// Estrutura do banco. Cada item roda uma única vez, na ordem, e fica registrado
// em schema_migrations. Para mudar algo no futuro, adicione um item novo no fim
// (nunca edite um que já rodou): assim a atualização não perde dados.

import { pool } from './db.js';
import { log } from './log.js';

const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'presentes e espectadores',
    sql: `
      -- Uma linha por pessoa, identificada pelo ID permanente do TikTok.
      create table viewers (
        user_id        text primary key,
        unique_id      text not null default '',   -- @ mais recente
        nickname       text not null default '',   -- apelido mais recente
        display_name   text,                       -- nome definido por você no painel (opcional)
        hidden         boolean not null default false,
        first_seen_at  timestamptz not null default now(),
        last_seen_at   timestamptz not null default now()
      );

      -- Uma linha por presente (só o final de cada sequência).
      create table gift_events (
        id            bigserial primary key,
        event_key     text not null unique,        -- impede gravar o mesmo presente duas vezes
        user_id       text not null references viewers(user_id),
        unique_id     text not null default '',    -- @ no momento do presente
        nickname      text not null default '',    -- apelido no momento do presente
        gift_id       text not null default '',
        gift_name     text not null default '',
        coins_each    integer not null,
        quantity      integer not null,
        coins_total   integer not null,
        to_user_id    text,
        to_unique_id  text,
        to_host       boolean not null default true, -- false = presente para um convidado da live
        sent_at       timestamptz not null,
        received_at   timestamptz not null default now()
      );
      create index gift_events_sent_at_idx on gift_events (sent_at);
      create index gift_events_user_idx on gift_events (user_id, sent_at);

      -- Correções manuais feitas no painel (positivas ou negativas). Nunca editamos presentes.
      create table adjustments (
        id          bigserial primary key,
        user_id     text not null references viewers(user_id),
        month       text not null,                  -- formato AAAA-MM
        coins       integer not null,
        reason      text not null,
        created_at  timestamptz not null default now()
      );
      create index adjustments_month_idx on adjustments (month);

      -- Histórico da conexão com a live, para auditoria.
      create table connection_log (
        id      bigserial primary key,
        at      timestamptz not null default now(),
        status  text not null,
        detail  text
      );
    `,
  },
  {
    id: 2,
    name: 'prêmios, entregas e textos do site',
    sql: `
      -- Textos editáveis do site (agenda, regras etc.), guardados como JSON.
      create table settings (
        key         text primary key,
        value       jsonb not null,
        updated_at  timestamptz not null default now()
      );

      -- Um prêmio por mês (AAAA-MM).
      create table prizes (
        month        text primary key,
        title        text not null,
        description  text not null default '',
        updated_at   timestamptz not null default now()
      );

      -- Fotos do prêmio (arquivos no volume de uploads).
      create table prize_images (
        id          bigserial primary key,
        month       text not null references prizes(month) on delete cascade,
        file        text not null,
        alt         text not null default '',
        sort        integer not null default 0,
        created_at  timestamptz not null default now()
      );
      create index prize_images_month_idx on prize_images (month, sort);

      -- Ganhadores e entregas dos prêmios.
      create table deliveries (
        id            bigserial primary key,
        month         text not null,               -- mês do ranking (AAAA-MM)
        user_id       text references viewers(user_id),
        winner_name   text not null,               -- nome exibido no site
        prize_title   text not null,
        coins         integer,                     -- pontuação final do ganhador (opcional)
        status        text not null default 'aguardando' check (status in ('aguardando', 'entregue')),
        delivered_at  date,
        photo         text,                        -- foto da entrega (opcional)
        note          text not null default '',
        created_at    timestamptz not null default now()
      );
      create index deliveries_month_idx on deliveries (month desc);

      insert into settings (key, value) values ('site', '{
        "agenda": [],
        "regras": [
          "O ranking vale do dia 1 ao último dia de cada mês, no horário de Brasília.",
          "Conta o valor em moedas de todos os presentes enviados nas lives do @eteguru.",
          "Presentes enviados para convidados da live não contam.",
          "O TOP 1 do mês ganha o prêmio. O vencedor é anunciado ao vivo.",
          "Este ranking é parcial e não oficial. Em caso de diferença, vale o ranking oficial do TikTok."
        ],
        "privacidade": "Seu apelido do TikTok aparece publicamente neste ranking. Se preferir não aparecer, avise na live ou por mensagem que o nome é ocultado."
      }'::jsonb);
    `,
  },
  {
    id: 3,
    name: 'painel: sessões, auditoria e cadastro manual',
    sql: `
      -- Sessões de login do painel. Guardamos só o hash do token, nunca o token.
      create table admin_sessions (
        token_hash  text primary key,
        created_at  timestamptz not null default now(),
        expires_at  timestamptz not null,
        ip          text,
        user_agent  text
      );

      -- Tudo que é feito no painel fica registrado aqui (auditoria).
      create table admin_log (
        id       bigserial primary key,
        at       timestamptz not null default now(),
        action   text not null,
        details  jsonb not null default '{}'::jsonb,
        ip       text
      );
      create index admin_log_at_idx on admin_log (at desc);

      -- Cadastro manual pelo @: o ID real só é conhecido no primeiro presente.
      alter table viewers add column manual boolean not null default false;
      create index viewers_unique_id_idx on viewers (lower(unique_id));
    `,
  },
];

export async function migrate(): Promise<void> {
  await pool.query(`create table if not exists schema_migrations (
    id integer primary key, name text not null, applied_at timestamptz not null default now())`);
  const { rows } = await pool.query<{ id: number }>('select id from schema_migrations');
  const done = new Set(rows.map((r) => r.id));

  for (const m of migrations) {
    if (done.has(m.id)) continue;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(m.sql);
      await client.query('insert into schema_migrations (id, name) values ($1, $2)', [m.id, m.name]);
      await client.query('commit');
      log.info('banco atualizado', { migracao: m.id, nome: m.name });
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}

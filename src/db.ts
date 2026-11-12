// Conexão com o PostgreSQL. O pool reconecta sozinho se o banco reiniciar.

import pg from 'pg';
import { config } from './config.js';
import { errorInfo, log } from './log.js';

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => log.error('erro no banco (conexão ociosa)', errorInfo(err)));

/** Confere se o banco responde. Usado no /healthz. */
export async function dbPing(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch (err) {
    log.warn('banco não respondeu', errorInfo(err));
    return false;
  }
}

/** Espera o banco ficar pronto na subida (no Swarm o app pode iniciar antes do banco). */
export async function waitForDb(maxSeconds = 120): Promise<void> {
  const until = Date.now() + maxSeconds * 1000;
  while (Date.now() < until) {
    if (await dbPing()) {
      log.info('banco conectado');
      return;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error('Banco não ficou disponível a tempo');
}

// Login do painel: uma senha forte (variável ADMIN_PASSWORD), sessão por cookie
// seguro, limite de tentativas por IP e registro de auditoria.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { config } from '../config.js';
import { pool } from '../db.js';
import { log } from '../log.js';

export const COOKIE = 'eteguru_admin';
const SESSION_DAYS = 7;
const MIN_PASSWORD = 16;

// ---------- Senha ----------
// A senha nunca é comparada em texto: guardamos só o hash em memória e
// comparamos em tempo constante (evita descobrir a senha pelo tempo de resposta).
const salt = randomBytes(16);
const expected = config.adminPassword.length >= MIN_PASSWORD
  ? scryptSync(config.adminPassword, salt, 64)
  : null;

export const adminEnabled = expected !== null;
if (!adminEnabled) {
  log.warn(`painel DESLIGADO: defina ADMIN_PASSWORD com pelo menos ${MIN_PASSWORD} caracteres`);
}

function passwordOk(input: string): boolean {
  if (!expected || typeof input !== 'string' || input.length > 200) return false;
  return timingSafeEqual(scryptSync(input, salt, 64), expected);
}

// ---------- Limite de tentativas ----------
// 5 erros em 15 minutos bloqueiam aquele IP por 15 minutos.
const attempts = new Map<string, { count: number; first: number; blockedUntil: number }>();
const WINDOW = 15 * 60_000;

function isBlocked(ip: string): boolean {
  const a = attempts.get(ip);
  return !!a && a.blockedUntil > Date.now();
}

function registerFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.first > WINDOW) {
    attempts.set(ip, { count: 1, first: now, blockedUntil: 0 });
    return;
  }
  a.count++;
  if (a.count >= 5) a.blockedUntil = now + WINDOW;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now - a.first > WINDOW && a.blockedUntil < now) attempts.delete(ip);
}, 60_000).unref();

// ---------- Sessões ----------
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function audit(action: string, details: Record<string, unknown>, ip?: string) {
  await pool.query('insert into admin_log (action, details, ip) values ($1, $2, $3)', [action, details, ip ?? null]);
  log.info('painel: ' + action, details);
}

export async function login(req: FastifyRequest, reply: FastifyReply) {
  const ip = req.ip;
  if (!adminEnabled) return reply.code(503).send({ erro: 'Painel desligado: falta configurar ADMIN_PASSWORD.' });
  if (isBlocked(ip)) {
    return reply.code(429).send({ erro: 'Muitas tentativas. Espere 15 minutos.' });
  }
  const senha = (req.body as { senha?: string } | undefined)?.senha ?? '';
  // Pequena espera fixa em toda tentativa: deixa ataques de força bruta bem mais lentos.
  await new Promise((r) => setTimeout(r, 400));
  if (!passwordOk(senha)) {
    registerFailure(ip);
    await audit('login falhou', {}, ip);
    return reply.code(401).send({ erro: 'Senha incorreta.' });
  }
  attempts.delete(ip);
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into admin_sessions (token_hash, expires_at, ip, user_agent)
     values ($1, now() + interval '${SESSION_DAYS} days', $2, $3)`,
    [hash(token), ip, String(req.headers['user-agent'] ?? '').slice(0, 200)],
  );
  await pool.query('delete from admin_sessions where expires_at < now()');
  await audit('login', {}, ip);
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
  return { ok: true };
}

export async function logout(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) await pool.query('delete from admin_sessions where token_hash = $1', [hash(token)]);
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
}

/** Confere se a pessoa está logada. Usado antes de toda rota do painel. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!adminEnabled) return reply.code(503).send({ erro: 'Painel desligado.' });

  // Proteção contra outro site tentar agir em seu nome (CSRF): pedidos que mudam
  // algo precisam vir deste mesmo domínio.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (origin && host && new URL(origin).host !== host) {
      return reply.code(403).send({ erro: 'Origem não permitida.' });
    }
  }

  const token = req.cookies[COOKIE];
  if (!token) return reply.code(401).send({ erro: 'Faça login.' });
  const { rows } = await pool.query('select 1 from admin_sessions where token_hash = $1 and expires_at > now()', [hash(token)]);
  if (!rows[0]) {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(401).send({ erro: 'Sessão expirada. Faça login de novo.' });
  }
}

// Lê as configurações das variáveis de ambiente (preenchidas no Portainer).
// Nenhuma senha ou chave fica no código.

import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return v.trim();
}

function optional(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  port: Number(optional('PORT', '3000')),
  tiktokUsername: optional('TIKTOK_USERNAME', 'eteguru').replace(/^@/, ''),
  eulerApiKey: optional('EULER_API_KEY') || undefined,
  collectorEnabled: optional('COLLECTOR_ENABLED', 'true') !== 'false',
  /** Pasta das imagens enviadas pelo painel (no Docker fica num volume). */
  uploadDir: resolve(optional('UPLOAD_DIR', '/app/data/uploads')),
  /** Senha do painel. Sem ela (ou curta demais), o painel fica desligado. */
  adminPassword: optional('ADMIN_PASSWORD'),
  /** Em produção o cookie de login só trafega por HTTPS. */
  secureCookies: optional('NODE_ENV') === 'production',
  db: {
    host: optional('DB_HOST', 'db'),
    port: Number(optional('DB_PORT', '5432')),
    user: optional('DB_USER', 'eteguru'),
    database: optional('DB_NAME', 'eteguru'),
    get password() { return required('DB_PASSWORD'); },
  },
};

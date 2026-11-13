// Recebe uma foto do painel, confere se é imagem de verdade, reduz o tamanho
// (máx. 1600 px, formato WebP) e remove os dados escondidos da foto (EXIF),
// como a localização GPS do celular.

import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'heif', 'gif']);

export class UploadError extends Error {}

/** Salva a imagem e devolve o nome do arquivo criado. */
export async function saveImage(buffer: Buffer): Promise<string> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new UploadError('Arquivo não é uma imagem válida.');
  }
  if (!meta.format || !ALLOWED.has(meta.format)) {
    throw new UploadError('Use fotos JPG, PNG, WebP ou HEIC.');
  }
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.webp`;
  await sharp(buffer, { failOn: 'error' })
    .rotate() // corrige a rotação da foto do celular antes de apagar o EXIF
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(join(config.uploadDir, name)); // sem .withMetadata(): o EXIF não é copiado
  return name;
}

export async function deleteImage(name: string | null | undefined) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return;
  try { await unlink(join(config.uploadDir, name)); } catch { /* já não existia */ }
}

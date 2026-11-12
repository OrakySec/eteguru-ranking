// Banco PostgreSQL de teste, só para rodar no seu computador (não vai para a VPS).
// Uso: npx tsx scripts/dev-db.ts   (fica escutando em 127.0.0.1:5432; os dados somem ao fechar)

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: Number(process.env.DEV_DB_PORT ?? 5432), host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log('Banco de teste no ar em 127.0.0.1:' + (process.env.DEV_DB_PORT ?? 5432));

const stop = async () => { await server.stop(); await db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

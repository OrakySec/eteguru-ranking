// Roda o site no seu computador usando o banco de teste (scripts/dev-db.ts).
// Coletor da live desligado e ferramenta de presente falso ligada.
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_USER ??= 'postgres';
process.env.DB_NAME ??= 'postgres';
process.env.DB_PASSWORD ??= 'dev';
process.env.COLLECTOR_ENABLED ??= 'false';
process.env.DEV_TOOLS ??= 'true';
process.env.PORT ??= '3000';

await import('../src/index.ts');

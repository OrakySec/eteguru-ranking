// Log simples em uma linha por evento, com data e hora. Aparece em "Logs" do container no Portainer.

type Level = 'info' | 'warn' | 'error';

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else console.log(out);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.name, detail: err.message };
  return { error: String(err) };
}

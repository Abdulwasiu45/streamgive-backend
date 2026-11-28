export interface ScriptLoggerOptions {
  json?: boolean;
}

export interface ScriptLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createScriptLogger(options: ScriptLoggerOptions = {}): ScriptLogger {
  const { json = false } = options;

  function log(level: string, message: string, data?: Record<string, unknown>): void {
    if (json) {
      console.log(JSON.stringify({ level, message, ...data }));
    } else {
      const prefix = level === 'info' ? '' : `[${level.toUpperCase()}] `;
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`${prefix}${message}${dataStr}`);
    }
  }

  return {
    info(message: string, data?: Record<string, unknown>): void {
      log('info', message, data);
    },
    warn(message: string, data?: Record<string, unknown>): void {
      log('warn', message, data);
    },
    error(message: string, data?: Record<string, unknown>): void {
      log('error', message, data);
    },
  };
}

import { styleText } from 'node:util';

type Style = string | string[];

type LogMethod = 'log' | 'warn' | 'error' | 'debug';

function print(
  method: LogMethod,
  stream: NodeJS.WriteStream,
  style: Style,
  emoji: string,
  message: unknown,
  args: unknown[],
): void {
  const options = { stream };
  if (typeof message === 'string') {
    const prefix = emoji ? `${emoji} ` : '';
    console[method](styleText(style, `${prefix}${message}`, options), ...args);
  } else if (emoji) {
    console[method](styleText(style, emoji, options), message, ...args);
  } else {
    console[method](message, ...args);
  }
}

export function info(message: unknown, ...args: unknown[]): void {
  print('log', process.stdout, 'cyan', 'ℹ️', message, args);
}

export function warn(message: unknown, ...args: unknown[]): void {
  print('warn', process.stderr, 'yellow', '⚠️', message, args);
}

export function error(message: unknown, ...args: unknown[]): void {
  print('error', process.stderr, ['bold', 'red'], '❌', message, args);
}

export function debug(message: unknown, ...args: unknown[]): void {
  print('debug', process.stdout, 'dim', '', message, args);
}

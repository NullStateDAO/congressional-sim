export type Arguments = Record<string, string | boolean>;

export function parseArgs(argv = process.argv.slice(2)): Arguments {
  const result: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const [rawName, inline] = token.slice(2).split('=', 2);
    if (!rawName) continue;
    if (inline !== undefined) {
      result[rawName] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[rawName] = next;
      index += 1;
    } else {
      result[rawName] = true;
    }
  }
  return result;
}

export function stringArg(
  args: Arguments,
  name: string,
  fallback?: string,
): string {
  const value = args[name] ?? fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function numberArg(
  args: Arguments,
  name: string,
  fallback: number,
): number {
  const value = Number(args[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

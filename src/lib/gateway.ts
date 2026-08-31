import { existsSync } from 'node:fs';
import path from 'node:path';

const BUNDLED_GATEWAY = path.resolve(
  import.meta.dirname,
  '../../tools/devops-gateway/bin/devops-gateway.mjs',
);

export function resolveGateway(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (process.env.DEVOPS_GATEWAY) return process.env.DEVOPS_GATEWAY;
  if (existsSync(BUNDLED_GATEWAY)) return BUNDLED_GATEWAY;
  return 'devops-gateway';
}

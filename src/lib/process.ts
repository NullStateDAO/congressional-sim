import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; quiet?: boolean } = {},
): Promise<string> {
  if (!options.quiet) console.log(`$ ${command} ${args.join(' ')}`);
  if (options.input !== undefined) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        const output = Buffer.concat(stdout).toString('utf8');
        if (code === 0) resolve(output);
        else {
          reject(
            new Error(
              `${command} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').slice(0, 8_000)}`,
            ),
          );
        }
      });
      child.stdin.end(options.input);
    });
  }
  const result = await executeFile(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    maxBuffer: 50 * 1024 * 1024,
    encoding: 'utf8',
  });
  return result.stdout;
}

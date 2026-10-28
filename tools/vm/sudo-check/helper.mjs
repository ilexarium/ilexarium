// Prototype of the per-session helper: JSON lines in, JSON lines out, spawn with an argv, no shell.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ ready: true, pid: process.pid, tty: process.stdin.isTTY });
createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return out({ error: 'bad json' });
  }
  const child = spawn(req.argv[0], req.argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'C' },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (e) => out({ id: req.id, error: String(e) }));
  child.on('close', (code) => out({ id: req.id, code, stdout, stderr }));
  // A child that exits without reading its input (tail, systemctl) closes the pipe first.
  child.stdin.on('error', () => {});
  child.stdin.end(req.stdin ?? '');
});

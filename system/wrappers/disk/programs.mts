// disk/programs.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Running systemctl — one fixed way, a clean environment, its output relayed with "> ".

import { spawn } from 'node:child_process';
import { emit } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';

export interface Ran {
  code: number;
  /** Its output (both streams), for telling "target is busy" apart. */
  text: string;
}

export function systemctl(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', HOME: '/' },
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let text = '';
    const relay = (stream: NodeJS.ReadableStream) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (text.length < 64 * 1024) text += chunk;
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) emit(`> ${line}`);
      });
      stream.on('end', () => rest && emit(`> ${rest}`));
    };
    relay(child.stdout!);
    relay(child.stderr!);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, text }));
  });
}

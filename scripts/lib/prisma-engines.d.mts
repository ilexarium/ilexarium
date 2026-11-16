export const ENGINE_TARGETS: string[];
export function downloadEngines(root: string, dir: string): Promise<string>;
export function engineHashes(dir: string, version: string): Record<string, string>;
export function checkEngines(dir: string, version: string, pinned: Record<string, string>): void;

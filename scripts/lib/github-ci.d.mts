export const WORKFLOW: string;
export function passCi(options: {
  gh: (args: string[]) => string;
  sha: string;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  interval?: number;
}): Promise<void>;

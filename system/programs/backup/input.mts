// backup/input.mts — runs as root.
//
// The input of an action: a JSON object with exactly the keys it takes (lib/input.mts, shared
// with the disk wrapper).

export { parseInput, requireNoInput } from '../lib/input.mts';

export const MAX_INPUT_BYTES = 256 * 1024;

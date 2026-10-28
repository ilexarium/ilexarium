// lib/input.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The input of an action: a JSON object with exactly the keys it takes.

import { Refusal } from './output.mts';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The input as a JSON object with exactly these keys (optional ones may be missing). */
export function parseInput(
  input: string,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Refusal('invalid_request', 'not JSON');
  }
  if (!isObject(value)) throw new Refusal('invalid_request', 'not an object');
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Refusal('invalid_request', `unknown key ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Refusal('invalid_request', `missing ${key}`);
  }
  return value;
}

export function requireNoInput(input: string): void {
  if (input.length > 0) throw new Refusal('invalid_request', 'this action takes no input');
}

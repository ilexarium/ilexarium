import type { KeyObject } from 'node:crypto';

export const SCRYPT_COST: { N: number; r: number; p: number };
export function sealKey(
  privateKey: KeyObject,
  passphrase: string,
  cost?: { N: number; r: number; p: number },
): string;
export function openKey(text: string, passphrase: string): KeyObject;
export function openKeyOrPem(text: string, passphrase: string): KeyObject;
export function generatePassphrase(): string;

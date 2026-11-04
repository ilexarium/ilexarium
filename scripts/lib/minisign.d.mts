import type { KeyObject } from 'node:crypto';

export function keyIdOf(key: KeyObject): Buffer;
export function publicKeyFile(key: KeyObject): string;
export function signatureFile(privateKey: KeyObject, data: Buffer, fileName: string): string;

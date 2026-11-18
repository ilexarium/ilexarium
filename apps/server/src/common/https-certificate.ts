import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { CERTIFICATE_HINT } from './https-certificate.constants.js';
import type { Certificate } from './systemd-socket.model.js';

/**
 * The HTTPS certificate and its key, checked to belong together: a missing, unreadable or
 * mismatched pair stops the app with what to do, rather than failing every browser's handshake.
 */
export async function readCertificate(certFile: string, keyFile: string): Promise<Certificate> {
  const [cert, key] = await Promise.all([readPem(certFile), readPem(keyFile)]);
  try {
    createSecureContext({ cert, key });
  } catch (error) {
    throw new Error(
      `${certFile} and ${keyFile} are not a certificate and its key ` +
        `(${(error as Error).message}). ${CERTIFICATE_HINT}`,
      { cause: error },
    );
  }
  return { cert, key };
}

async function readPem(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Error(
      `The HTTPS certificate: ${file} could not be read (${code}). ${CERTIFICATE_HINT}`,
      {
        cause: error,
      },
    );
  }
}

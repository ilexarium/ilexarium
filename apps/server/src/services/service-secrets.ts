import { Injectable } from '@nestjs/common';
import type { FieldValues } from '@laris/shared';
import type { CatalogEntry } from '../catalog/catalog.model.js';
import { SecretsService } from '../secrets/secrets.service.js';

/** Where a service's secret is bound (the AES-GCM associated data): its row and field. */
const secretContext = (serviceId: string, key: string) => `service:${serviceId}:${key}`;

/** A previous install's stored secrets (encrypted), by field key. */
export interface StoredSecrets {
  serviceId: string;
  values: ReadonlyMap<string, Uint8Array>;
}

/**
 * A service's secrets: which ones a previous install already has, the value of each for a deploy
 * (entered, kept or generated), and their encrypted form for the database. Plain text exists only
 * in memory, on its way to the wrapper's stdin.
 */
@Injectable()
export class ServiceSecrets {
  constructor(private readonly secrets: SecretsService) {}

  /** Secret fields (entered by the user) a previous install has a value for: may be left empty. */
  keptKeys(entry: CatalogEntry, storedKeys: readonly string[]): string[] {
    return entry.meta.fields
      .filter((f) => f.type === 'secret' && storedKeys.includes(f.key))
      .map((f) => f.key);
  }

  /**
   * Splits checked values into plain settings and secret values. A secret is what the user
   * entered, or — left empty — the previous install's; a generated secret is the previous one, or
   * new. A reinstall must reuse them: the service's data was set up with them.
   */
  resolve(
    entry: CatalogEntry,
    values: FieldValues,
    previous: StoredSecrets | null,
  ): { settings: FieldValues; secretValues: Record<string, string> } {
    const settings: FieldValues = {};
    const secretValues: Record<string, string> = {};
    for (const field of entry.meta.fields) {
      const value = values[field.key];
      const stored = previous?.values.get(field.key);
      const reuse = () =>
        this.secrets.decrypt(stored!, secretContext(previous!.serviceId, field.key));
      if (field.type === 'secret') {
        secretValues[field.key] = value === '' && stored ? reuse() : String(value);
      } else if (field.type === 'generatedSecret') {
        secretValues[field.key] = stored ? reuse() : this.secrets.generate();
      } else {
        settings[field.key] = value;
      }
    }
    return { settings, secretValues };
  }

  /** The rows to store for a service: each secret encrypted and bound to its row and field. */
  rows(
    serviceId: string,
    secretValues: Record<string, string>,
  ): { serviceId: string; key: string; value: Uint8Array<ArrayBuffer> }[] {
    return Object.entries(secretValues).map(([key, value]) => ({
      serviceId,
      key,
      value: new Uint8Array(this.secrets.encrypt(value, secretContext(serviceId, key))),
    }));
  }
}

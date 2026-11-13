export function manifestFile(release: {
  version: string;
  archive: Buffer;
  notes?: boolean;
  published?: Date;
}): Buffer;

// A release's manifest, as it's signed: JSON with one field per line, which get-ilex.sh reads line
// by line (ilex-update and the app parse it). The notes, when the release has them, are a file
// beside it.
import { createHash } from 'node:crypto';

export function manifestFile({ version, archive, notes = false, published = new Date() }) {
  const manifest = {
    version,
    published: published.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    archive: `ilex-${version}.tar.gz`,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
  };
  if (notes) manifest.notes = 'NOTES.md';
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

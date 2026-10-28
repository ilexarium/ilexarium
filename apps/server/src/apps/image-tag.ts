import { isMap, isScalar, parseDocument } from 'yaml';
import { splitImage } from './compose-fields.js';

/**
 * A service's image tag changed in place: only that scalar is rewritten, so comments, order and
 * the rest of the formatting stay as the person wrote them. A digest goes with the old tag (it
 * would pin the old image); one in the new tag (`1.2@sha256:…`) stays. Null: no such service.
 */
export function withImageTag(compose: string, service: string, tag: string): string | null {
  const document = parseDocument(compose, { keepSourceTokens: true });
  if (document.errors.length > 0) return null;
  const services = document.get('services');
  if (!isMap(services)) return null;
  const definition = services.get(service);
  if (!isMap(definition)) return null;
  const node = definition.get('image', true);
  if (!isScalar(node) || typeof node.value !== 'string') return null;
  node.value = `${splitImage(node.value).image}:${tag}`;
  return document.toString();
}

import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AI_ERROR_CODES,
  AI_LIMITS,
  type AiLibrary,
  type AiLibraryDetail,
  type AiLibraryFile,
} from '@laris/shared';
import { z } from 'zod';
import {
  GGUF_QUANT,
  GGUF_SPLIT,
  HF_API,
  HF_CACHE_ENTRIES,
  HF_CACHE_MS,
  HF_MAX_BYTES,
  HF_TIMEOUT_MS,
} from './assistant.constants.js';

const listSchema = z.array(
  z.object({
    id: z.string(),
    downloads: z.number().optional(),
    likes: z.number().optional(),
    lastModified: z.string().optional(),
  }),
);
const detailSchema = z.object({
  id: z.string(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  cardData: z.object({ license: z.unknown().optional() }).partial().optional(),
  siblings: z.array(z.object({ rfilename: z.string(), size: z.number().optional() })).optional(),
});

/**
 * Hugging Face's public model API (docs/plans/ai_assistant.md): GGUF models to search, and the
 * sizes a repository offers. The server asks — never the browser — and only `huggingface.co`:
 * the host is fixed, a request only chooses the search words or a checked `owner/repo`. Answers
 * are size-limited, checked and cached a few minutes.
 */
@Injectable()
export class HfLibrary {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  async search(search: string): Promise<AiLibrary> {
    const params = new URLSearchParams({
      filter: 'gguf',
      sort: 'downloads',
      limit: String(AI_LIMITS.libraryResults),
    });
    if (search) params.set('search', search);
    const list = checked(listSchema, await this.get(`${HF_API}?${params}`));
    return {
      models: list.map((model) => ({
        id: model.id,
        downloads: Math.max(0, Math.round(model.downloads ?? 0)),
        likes: Math.max(0, Math.round(model.likes ?? 0)),
        updatedAt: iso(model.lastModified),
      })),
    };
  }

  /** `owner` and `repo` are checked by the route (`aiLibraryParamsSchema`). */
  async detail(owner: string, repo: string): Promise<AiLibraryDetail> {
    const url = `${HF_API}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?blobs=true`;
    const detail = checked(detailSchema, await this.get(url));
    const files = new Map<string, AiLibraryFile>();
    for (const file of detail.siblings ?? []) {
      // Split files ("-00001-of-00003.gguf") can't be downloaded by name: left out.
      if (GGUF_SPLIT.test(file.rfilename)) continue;
      const quantization = GGUF_QUANT.exec(file.rfilename)?.[1];
      if (!quantization || files.has(quantization.toUpperCase())) continue;
      files.set(quantization.toUpperCase(), {
        quantization,
        sizeBytes: file.size !== undefined ? Math.max(0, Math.round(file.size)) : null,
        model: `hf.co/${owner}/${repo}:${quantization}`,
      });
    }
    const license = detail.cardData?.license;
    return {
      id: `${owner}/${repo}`,
      gated: detail.gated !== undefined && detail.gated !== false,
      license: typeof license === 'string' ? license.slice(0, 100) : null,
      files: [...files.values()].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)),
    };
  }

  private async get(url: string): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < HF_CACHE_MS) return cached.value;
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw unreachable();
    }
    if (response.status === 404 || response.status === 401) {
      throw new NotFoundException({
        message: 'No such model on Hugging Face',
        code: AI_ERROR_CODES.libraryNotFound,
      });
    }
    if (!response.ok) throw unreachable();
    const value = await readJson(response);
    this.cache.set(url, { at: Date.now(), value });
    while (this.cache.size > HF_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return value;
  }
}

/** The body as JSON, refused past `HF_MAX_BYTES`. */
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw unreachable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > HF_MAX_BYTES) throw unreachable();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw unreachable();
  }
}

/** An answer of an unexpected shape: as if Hugging Face hadn't answered. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unreachable();
  return result.data;
}

function iso(value: string | undefined): string | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function unreachable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'Hugging Face is not reachable',
    code: AI_ERROR_CODES.libraryUnreachable,
  });
}

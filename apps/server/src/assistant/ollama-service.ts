import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AI_ERROR_CODES, type AiModels, type AiStatus } from '@laris/shared';
import { DockerService } from '../docker/docker.service.js';
import { OLLAMA_API_PORT, OLLAMA_HOST_ADDRESSES, OLLAMA_IMAGE } from './assistant.constants.js';
import type { OllamaLocation } from './assistant.model.js';
import { OllamaClient, OllamaError } from './ollama-client.js';

/**
 * Finds Ollama through Docker — a running container of the `ollama/ollama` image whose API is
 * published on this machine (the first, by name, when there are several) — and asks it things.
 * Its address is always 127.0.0.1 and the port Docker reports: nothing from a request decides
 * where we connect.
 */
@Injectable()
export class OllamaService {
  constructor(private readonly dockerService: DockerService) {}

  /** Null when no Ollama runs here (or Docker can't be asked). */
  async location(): Promise<OllamaLocation | null> {
    const containers = await this.dockerService.listContainers().catch(() => []);
    for (const container of containers) {
      if (!OLLAMA_IMAGE.test(container.image) || container.state !== 'running') continue;
      const published = container.ports.find(
        (port) =>
          port.privatePort === OLLAMA_API_PORT &&
          port.protocol === 'tcp' &&
          port.publicPort !== undefined &&
          OLLAMA_HOST_ADDRESSES.includes(port.ip ?? ''),
      );
      if (!published?.publicPort) continue;
      const [modelsDir] = await this.dockerService.bindMounts(container.name);
      return { baseUrl: `http://127.0.0.1:${published.publicPort}`, modelsDir: modelsDir ?? null };
    }
    return null;
  }

  /** The client for the installed Ollama; a 503 with a code when it isn't installed. */
  async client(): Promise<{ client: OllamaClient; location: OllamaLocation }> {
    const location = await this.location();
    if (!location) {
      throw new ServiceUnavailableException({
        message: 'Ollama is not installed',
        code: AI_ERROR_CODES.ollamaNotInstalled,
      });
    }
    return { client: new OllamaClient(location.baseUrl), location };
  }

  async status(): Promise<AiStatus> {
    const location = await this.location();
    if (!location) return { state: 'not_installed', version: null };
    try {
      const version = await new OllamaClient(location.baseUrl).version();
      return { state: 'ready', version };
    } catch {
      return { state: 'not_running', version: null };
    }
  }

  async models(): Promise<AiModels> {
    const { client } = await this.client();
    try {
      const [tags, loaded] = await Promise.all([client.tags(), client.loaded()]);
      const models = tags.models
        .map((model) => ({
          name: model.name,
          sizeBytes: Math.max(0, Math.round(model.size)),
          family: model.details?.family || null,
          parameterSize: model.details?.parameter_size || null,
          quantization: model.details?.quantization_level || null,
          modifiedAt: toIso(model.modified_at),
          loaded: loaded.has(model.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { models };
    } catch (error) {
      throw unreachable(error);
    }
  }

  async remove(model: string): Promise<void> {
    const { client } = await this.client();
    try {
      await client.remove(model);
    } catch (error) {
      if (error instanceof OllamaError && error.status === 404) {
        throw new NotFoundException({
          message: 'No such model',
          code: AI_ERROR_CODES.modelNotFound,
        });
      }
      throw unreachable(error);
    }
  }
}

/** Ollama's times have nanoseconds; ours are ISO with milliseconds. */
function toIso(value: string): string {
  const time = Date.parse(value);
  return new Date(Number.isNaN(time) ? 0 : time).toISOString();
}

export function unreachable(error: unknown): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: error instanceof OllamaError ? error.message : 'Ollama is not reachable',
    code: AI_ERROR_CODES.ollamaUnreachable,
  });
}

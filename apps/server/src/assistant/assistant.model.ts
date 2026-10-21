import type { ChatStreamEvent, PublicUser } from '@laris/shared';

/** Where Ollama runs: its loopback address and the models' folder. */
export interface OllamaLocation {
  baseUrl: string;
  modelsDir: string | null;
}

/** One message as Ollama takes it. */
export interface OllamaMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Download progress as Ollama reports it, per part. */
export interface OllamaPullLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** Who asked: for the audit log. */
export interface Requester {
  user: PublicUser;
  ip: string;
}

/** Where an answer goes: one JSON line at a time, waiting while the browser is slow. */
export interface AnswerSink {
  write(event: ChatStreamEvent): Promise<void>;
}

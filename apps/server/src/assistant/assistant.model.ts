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

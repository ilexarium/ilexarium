/** The catalog entry that runs the models, and its fields. */
export const OLLAMA_CATALOG_ID = 'ollama';
export const OLLAMA_PORT_FIELD = 'API_PORT';
export const OLLAMA_MODELS_FIELD = 'MODELS_DIR';

/** A quick question (status, the model list, removing one). */
export const OLLAMA_REQUEST_MS = 10_000;
/** A streaming answer or download: given up after this long without a byte (a model can take a while to load). */
export const OLLAMA_IDLE_MS = 5 * 60_000;

/**
 * A download refused because the model doesn't exist: Ollama says so only in its message
 * ("pull model manifest: file does not exist"), with no code to go by.
 */
export const PULL_NOT_FOUND = /not exist|not found|manifest/i;

/** Kept free on the models' disk beyond a download's size. */
export const FREE_SPACE_MARGIN_BYTES = 1024 ** 3;

/** Download progress: at most one update this often. */
export const PULL_PUBLISH_MS = 250;

/** Hugging Face: the only outside host the Assistant asks (searches; Ollama downloads itself). */
export const HF_API = 'https://huggingface.co/api/models';
export const HF_TIMEOUT_MS = 10_000;
/** A search or a repository's file list is small; more is refused. */
export const HF_MAX_BYTES = 2 * 1024 * 1024;
export const HF_CACHE_MS = 5 * 60_000;
export const HF_CACHE_ENTRIES = 100;
/** The quantisation in a GGUF file's name: "…-Q4_K_M.gguf", "…-IQ3_XS.gguf", "…-f16.gguf". */
export const GGUF_QUANT = /[-.]((?:I?Q\d[A-Z0-9_]*)|(?:[Ff](?:16|32))|(?:BF16|bf16))\.gguf$/;

/** Per IP: downloads and removals. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** Per IP: questions to Hugging Face. */
export const LIBRARY_LIMIT = { default: { limit: 30, ttl: 60_000 } };
/** Per IP: messages (each also waits for the one before). */
export const SEND_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/** A model split over several files ("-00001-of-00003.gguf"): Ollama can't download it by name. */
export const GGUF_SPLIT = /-\d{5}-of-\d{5}\.gguf$/;

/** The message fields the app reads. */
export const MESSAGE_FIELDS = {
  id: true,
  role: true,
  content: true,
  model: true,
  stopped: true,
  createdAt: true,
} as const;

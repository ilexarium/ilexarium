import { z } from 'zod';

/**
 * The Assistant: chat with local models run by Ollama (a catalog service), download and remove
 * models, search Hugging Face for more. Design: docs/plans/ai_assistant.md.
 */

export const AI_LIMITS = {
  /** One message, in characters (about 4,000 tokens). */
  messageMax: 16_000,
  /** What's sent to the model: the newest messages that fit, in characters (about 6,000 tokens). */
  historyMax: 24_000,
  /** The context window asked of the model, in tokens. */
  contextTokens: 8192,
  /** A chat's title: its first message, shortened. */
  titleMax: 80,
  /** Chats listed per person. */
  chatsListed: 200,
  /** A model name ("llama3.2:3b", "hf.co/owner/repo:Q4_K_M"). */
  modelNameMax: 200,
  /** A Hugging Face search. */
  searchMax: 100,
  libraryResults: 20,
} as const;

/**
 * An Ollama model name: `[host/][namespace/]name[:tag]`, e.g. `llama3.2:3b`,
 * `hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M`. Plain machine text: no spaces, no "..".
 */
export const MODEL_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/**
 * The only registry hosts a name may name: Ollama pulls from whatever host a name starts with, so
 * any other would make the server fetch from an address of the requester's choosing.
 */
export const MODEL_HOSTS = ['hf.co', 'huggingface.co'] as const;

/** A name's host: the first of three parts (`hf.co/owner/repo`), else none (Ollama's library). */
export function modelHost(name: string): string | null {
  const parts = name.split(':')[0].split('/');
  return parts.length === 3 ? parts[0].toLowerCase() : null;
}

export const modelNameSchema = z
  .string()
  .trim()
  .min(1, 'validation.modelNameRequired')
  .max(AI_LIMITS.modelNameMax, 'validation.modelNameInvalid')
  .regex(MODEL_NAME_PATTERN, 'validation.modelNameInvalid')
  .refine((name) => !name.includes('..'), 'validation.modelNameInvalid')
  .refine((name) => {
    const host = modelHost(name);
    return host === null || (MODEL_HOSTS as readonly string[]).includes(host);
  }, 'validation.modelNameInvalid');

/** One part of a Hugging Face repository id (`owner` or `repo`). */
export const HF_ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function isHfIdPart(part: string): boolean {
  return HF_ID_PART.test(part) && !part.includes('..');
}

// Status and models.

export const AI_STATES = ['not_installed', 'not_running', 'ready'] as const;
export const aiStateSchema = z.enum(AI_STATES);
export type AiState = z.infer<typeof aiStateSchema>;

export const aiStatusSchema = z.object({
  state: aiStateSchema,
  /** Ollama's version, when it answers. */
  version: z.string().nullable(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

export const aiModelSchema = z.object({
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** e.g. "llama", "qwen2". */
  family: z.string().nullable(),
  /** e.g. "3.2B". */
  parameterSize: z.string().nullable(),
  /** e.g. "Q4_K_M". */
  quantization: z.string().nullable(),
  modifiedAt: z.iso.datetime(),
  /** Loaded in memory right now. */
  loaded: z.boolean(),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiModelsSchema = z.object({ models: z.array(aiModelSchema) });
export type AiModels = z.infer<typeof aiModelsSchema>;

export const aiPullRequestSchema = z.strictObject({ model: modelNameSchema });
export type AiPullRequest = z.infer<typeof aiPullRequestSchema>;

export const AI_PULL_STATUSES = ['running', 'succeeded', 'failed'] as const;

/** A model download: one at a time, its progress in the `assistant` topic. */
export const aiPullSchema = z.object({
  model: z.string(),
  status: z.enum(AI_PULL_STATUSES),
  /** Over all its parts; total 0 until Ollama knows. */
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type AiPull = z.infer<typeof aiPullSchema>;

/** The `assistant` topic: the current or last download (null: none since the server started). */
export const aiTopicSchema = z.object({ pull: aiPullSchema.nullable() });
export type AiTopic = z.infer<typeof aiTopicSchema>;

// Hugging Face.

export const aiLibrarySearchSchema = z.strictObject({
  search: z.string().trim().max(AI_LIMITS.searchMax).default(''),
});

export const aiLibraryModelSchema = z.object({
  /** `owner/repo`. */
  id: z.string(),
  downloads: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type AiLibraryModel = z.infer<typeof aiLibraryModelSchema>;

export const aiLibrarySchema = z.object({ models: z.array(aiLibraryModelSchema) });
export type AiLibrary = z.infer<typeof aiLibrarySchema>;

export const aiLibraryFileSchema = z.object({
  /** e.g. "Q4_K_M" — the tag Ollama downloads it by. */
  quantization: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** The Ollama name to download: `hf.co/<owner>/<repo>:<quantization>`. */
  model: z.string(),
});
export type AiLibraryFile = z.infer<typeof aiLibraryFileSchema>;

export const aiLibraryDetailSchema = z.object({
  id: z.string(),
  /** Needs a Hugging Face account and accepted terms: Ollama can't download it. */
  gated: z.boolean(),
  license: z.string().nullable(),
  files: z.array(aiLibraryFileSchema),
});
export type AiLibraryDetail = z.infer<typeof aiLibraryDetailSchema>;

// Chats.

export const CHAT_ROLES = ['user', 'assistant'] as const;
export const chatRoleSchema = z.enum(CHAT_ROLES);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z.object({
  id: z.uuid(),
  role: chatRoleSchema,
  content: z.string(),
  /** The model that wrote an answer. */
  model: z.string().nullable(),
  /** An answer stopped before the model finished. */
  stopped: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  model: z.string(),
  updatedAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatListSchema = z.object({ chats: z.array(chatSummarySchema) });
export type ChatList = z.infer<typeof chatListSchema>;

export const chatSchema = chatSummarySchema.extend({
  createdAt: z.iso.datetime(),
  messages: z.array(chatMessageSchema),
});
export type Chat = z.infer<typeof chatSchema>;

/** Send a message: to a chat, or (no `chatId`) starting a new one. The answer streams back. */
export const chatSendSchema = z.strictObject({
  chatId: z.uuid().nullable(),
  model: modelNameSchema,
  content: z
    .string()
    .trim()
    .min(1, 'validation.messageRequired')
    .max(AI_LIMITS.messageMax, 'validation.messageTooLong'),
});
export type ChatSend = z.infer<typeof chatSendSchema>;

/**
 * The streamed answer, one JSON object per line: `chat` first (the chat and the saved question),
 * then `text` pieces, then `done` or `error` (whatever was written is saved, marked stopped).
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat'),
    chat: chatSummarySchema,
    question: chatMessageSchema,
  }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('done'), answer: chatMessageSchema }),
  z.object({ type: z.literal('error'), code: z.string(), answer: chatMessageSchema.nullable() }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/** Codes the server answers with; the web app words them (`errors.<code>`). */
export const AI_ERROR_CODES = {
  ollamaNotInstalled: 'ollama_not_installed',
  ollamaUnreachable: 'ollama_unreachable',
  modelNotFound: 'model_not_found',
  /** One answer at a time per person. */
  answerRunning: 'answer_running',
  /** The model stopped answering, or Ollama failed while answering. */
  answerFailed: 'answer_failed',
  /** One download at a time. */
  pullRunning: 'pull_running',
  pullFailed: 'pull_failed',
  notEnoughSpace: 'not_enough_space',
  chatNotFound: 'chat_not_found',
  libraryUnreachable: 'library_unreachable',
  libraryNotFound: 'library_not_found',
} as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

/** Remove a model (a query: names contain "/" and ":"). */
export const aiModelQuerySchema = z.strictObject({ model: modelNameSchema });

export const chatIdParamsSchema = z.strictObject({ id: z.uuid() });

export const aiLibraryParamsSchema = z.strictObject({
  owner: z.string().refine(isHfIdPart),
  repo: z.string().refine(isHfIdPart),
});

/** The message box (the web form): the message alone, checked like the request. */
export const chatMessageFormSchema = z.object({ content: chatSendSchema.shape.content });
export type ChatMessageForm = z.infer<typeof chatMessageFormSchema>;

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AI_ERROR_CODES, AI_LIMITS, type ChatMessage, type ChatSend } from '@homelab/shared';
import type { AnswerSink, OllamaMessage } from './assistant.model.js';
import { ChatStore } from './chat-store.js';
import { OllamaService, unreachable } from './ollama-service.js';

/**
 * Answers a message (docs/plans/ai_assistant.md): saves the question, asks the model with the
 * conversation that fits, streams the answer and saves it — also a part of it when stopped or
 * failed. One answer at a time per person. Errors before the first line are HTTP errors; after
 * it, an `error` line.
 */
@Injectable()
export class ChatAnswers {
  private readonly logger = new Logger(ChatAnswers.name);
  private readonly answering = new Set<string>();

  constructor(
    private readonly ollama: OllamaService,
    private readonly chats: ChatStore,
  ) {}

  async answer(
    userId: string,
    send: ChatSend,
    sink: AnswerSink,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.answering.has(userId)) {
      throw new ConflictException({
        message: 'An answer is being written',
        code: AI_ERROR_CODES.answerRunning,
      });
    }
    this.answering.add(userId);
    try {
      await this.run(userId, send, sink, signal);
    } finally {
      this.answering.delete(userId);
    }
  }

  private async run(
    userId: string,
    send: ChatSend,
    sink: AnswerSink,
    signal: AbortSignal,
  ): Promise<void> {
    const { client } = await this.ollama.client();
    let installed: Set<string>;
    try {
      installed = new Set((await client.tags()).models.map((model) => model.name));
    } catch (error) {
      throw unreachable(error);
    }
    if (!installed.has(send.model)) {
      throw new NotFoundException({ message: 'No such model', code: AI_ERROR_CODES.modelNotFound });
    }
    const asked = await this.chats.ask(userId, send.chatId, send.model, send.content);
    if (!asked) {
      throw new NotFoundException({ message: 'No such chat', code: AI_ERROR_CODES.chatNotFound });
    }
    await sink.write({ type: 'chat', ...asked });

    const conversation = fitting(await this.chats.history(asked.chat.id));
    let text = '';
    try {
      for await (const piece of client.chat(
        send.model,
        conversation,
        AI_LIMITS.contextTokens,
        signal,
      )) {
        text += piece;
        await sink.write({ type: 'text', text: piece });
      }
      // Nothing written: a failure, not an (empty) answer the model would read back later.
      if (!text.trim()) throw new Error('The model wrote nothing');
      const answer = await this.chats.answer(asked.chat.id, send.model, text, false);
      await sink.write({ type: 'done', answer });
    } catch (error) {
      const answer = text.trim()
        ? await this.chats.answer(asked.chat.id, send.model, text, true).catch(() => null)
        : null;
      if (signal.aborted) return;
      this.logger.warn(`An answer failed: ${error instanceof Error ? error.message : 'unknown'}`);
      await sink
        .write({ type: 'error', code: AI_ERROR_CODES.answerFailed, answer })
        .catch(() => {});
    }
  }
}

/**
 * The newest messages that fit `AI_LIMITS.historyMax` characters, oldest first — the question
 * always (it's within `messageMax`, below the limit).
 */
export function fitting(history: ChatMessage[]): OllamaMessage[] {
  const kept: OllamaMessage[] = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const { role, content } = history[i];
    if (!content.trim()) continue;
    if (kept.length > 0 && size + content.length > AI_LIMITS.historyMax) break;
    size += content.length;
    kept.unshift({ role, content });
  }
  return kept;
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AI_ERROR_CODES,
  type AiLibrary,
  type AiLibraryDetail,
  type AiModels,
  type AiPull,
  type AiStatus,
  type Chat,
  type ChatList,
  type ChatStreamEvent,
  type PublicUser,
} from '@homelab/shared';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ChatAnswers } from './chat-answers.js';
import { ChatStore } from './chat-store.js';
import { HfLibrary } from './hf-library.js';
import { ModelPulls } from './model-pulls.js';
import { OllamaService } from './ollama-service.js';
import {
  AiLibraryParamsDto,
  AiLibrarySearchDto,
  AiModelQueryDto,
  AiPullDto,
  ChatIdParamsDto,
  ChatSendDto,
} from './assistant.dto.js';

/** Per IP: downloads and removals. */
const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** Per IP: questions to Hugging Face. */
const LIBRARY_LIMIT = { default: { limit: 30, ttl: 60_000 } };
/** Per IP: messages (each also waits for the one before). */
const SEND_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/** The Assistant (docs/plans/ai_assistant.md). Every route needs a session. */
@Controller('assistant')
@UseFilters(TooManyAttemptsFilter)
export class AssistantController {
  constructor(
    private readonly ollama: OllamaService,
    private readonly pulls: ModelPulls,
    private readonly library: HfLibrary,
    private readonly chats: ChatStore,
    private readonly answers: ChatAnswers,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  status(): Promise<AiStatus> {
    return this.ollama.status();
  }

  @Get('models')
  models(): Promise<AiModels> {
    return this.ollama.models();
  }

  /** Starts a download; progress comes through the `assistant` topic. */
  @Post('models/pull')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  pull(
    @Body() { model }: AiPullDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AiPull> {
    return this.pulls.start(model, { user, ip });
  }

  @Delete('models')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  async remove(
    @Query() { model }: AiModelQueryDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    const entry = {
      action: 'assistant.model_remove' as const,
      userId: user.id,
      username: user.username,
      ip,
      details: { model },
    };
    await this.audit.record({ ...entry, outcome: 'requested' });
    try {
      await this.ollama.remove(model);
    } catch (error) {
      await this.audit.tryRecord({ ...entry, outcome: 'failure' });
      throw error;
    }
    await this.audit.tryRecord({ ...entry, outcome: 'success' });
  }

  @Get('library')
  @UseGuards(ThrottlerGuard)
  @Throttle(LIBRARY_LIMIT)
  search(@Query() { search }: AiLibrarySearchDto): Promise<AiLibrary> {
    return this.library.search(search);
  }

  @Get('library/:owner/:repo')
  @UseGuards(ThrottlerGuard)
  @Throttle(LIBRARY_LIMIT)
  libraryDetail(@Param() { owner, repo }: AiLibraryParamsDto): Promise<AiLibraryDetail> {
    return this.library.detail(owner, repo);
  }

  @Get('chats')
  list(@CurrentUser() user: PublicUser): Promise<ChatList> {
    return this.chats.list(user.id);
  }

  @Get('chats/:id')
  async chat(@Param() { id }: ChatIdParamsDto, @CurrentUser() user: PublicUser): Promise<Chat> {
    const chat = await this.chats.get(user.id, id);
    if (!chat) throw chatNotFound();
    return chat;
  }

  @Delete('chats/:id')
  @HttpCode(204)
  async removeChat(
    @Param() { id }: ChatIdParamsDto,
    @CurrentUser() user: PublicUser,
  ): Promise<void> {
    if (!(await this.chats.remove(user.id, id))) throw chatNotFound();
  }

  /**
   * Sends a message; the answer streams back as JSON lines (`ChatStreamEvent`). Closing the
   * request stops the answer (what was written is kept, marked stopped).
   */
  @Post('chat')
  @UseGuards(ThrottlerGuard)
  @Throttle(SEND_LIMIT)
  async send(
    @Body() body: ChatSendDto,
    @CurrentUser() user: PublicUser,
    @Res() res: Response,
  ): Promise<void> {
    const stop = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) stop.abort();
    });
    let started = false;
    const write = (event: ChatStreamEvent): Promise<void> => {
      if (!started) {
        started = true;
        res.status(200).set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          // No proxy buffering: the pieces should arrive as they're written.
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
      }
      if (stop.signal.aborted) return Promise.resolve();
      const fits = res.write(`${JSON.stringify(event)}\n`);
      return fits ? Promise.resolve() : new Promise((resolve) => res.once('drain', resolve));
    };
    try {
      await this.answers.answer(user.id, body, { write }, stop.signal);
    } catch (error) {
      // Before the first line: an ordinary HTTP error (Nest's filter answers it).
      if (!started) throw error;
    }
    if (!res.writableEnded) res.end();
  }
}

function chatNotFound(): NotFoundException {
  return new NotFoundException({ message: 'No such chat', code: AI_ERROR_CODES.chatNotFound });
}

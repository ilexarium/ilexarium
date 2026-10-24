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
  type PublicUser,
} from '@laris/shared';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { CHANGE_LIMIT, LIBRARY_LIMIT, SEND_LIMIT } from './assistant.constants.js';
import { ndjsonWriter } from './ndjson-response.js';
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

/** The Assistant (docs/plans/ai_assistant.md). Every route needs a session. */
@Controller('assistant')
@UseFilters(TooManyAttemptsFilter)
export class AssistantController {
  constructor(
    private readonly ollamaService: OllamaService,
    private readonly modelPulls: ModelPulls,
    private readonly hfLibrary: HfLibrary,
    private readonly chatStore: ChatStore,
    private readonly chatAnswers: ChatAnswers,
    private readonly auditService: AuditService,
  ) {}

  @Get('status')
  status(): Promise<AiStatus> {
    return this.ollamaService.status();
  }

  @Get('models')
  models(): Promise<AiModels> {
    return this.ollamaService.models();
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
    return this.modelPulls.start(model, { user, ip });
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
    await this.auditService.record({ ...entry, outcome: 'requested' });
    try {
      await this.ollamaService.remove(model);
    } catch (error) {
      await this.auditService.tryRecord({ ...entry, outcome: 'failure' });
      throw error;
    }
    await this.auditService.tryRecord({ ...entry, outcome: 'success' });
  }

  @Get('library')
  @UseGuards(ThrottlerGuard)
  @Throttle(LIBRARY_LIMIT)
  search(@Query() { search }: AiLibrarySearchDto): Promise<AiLibrary> {
    return this.hfLibrary.search(search);
  }

  @Get('library/:owner/:repo')
  @UseGuards(ThrottlerGuard)
  @Throttle(LIBRARY_LIMIT)
  libraryDetail(@Param() { owner, repo }: AiLibraryParamsDto): Promise<AiLibraryDetail> {
    return this.hfLibrary.detail(owner, repo);
  }

  @Get('chats')
  list(@CurrentUser() user: PublicUser): Promise<ChatList> {
    return this.chatStore.list(user.id);
  }

  @Get('chats/:id')
  async chat(@Param() { id }: ChatIdParamsDto, @CurrentUser() user: PublicUser): Promise<Chat> {
    const chat = await this.chatStore.get(user.id, id);
    if (!chat) throw chatNotFound();
    return chat;
  }

  @Delete('chats/:id')
  @HttpCode(204)
  async removeChat(
    @Param() { id }: ChatIdParamsDto,
    @CurrentUser() user: PublicUser,
  ): Promise<void> {
    if (!(await this.chatStore.remove(user.id, id))) throw chatNotFound();
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
    const writer = ndjsonWriter(res, stop.signal);
    try {
      await this.chatAnswers.answer(user.id, body, writer, stop.signal);
    } catch (error) {
      // Before the first line: an ordinary HTTP error (Nest's filter answers it).
      if (!writer.started) throw error;
    }
    if (!res.writableEnded) res.end();
  }
}

function chatNotFound(): NotFoundException {
  return new NotFoundException({ message: 'No such chat', code: AI_ERROR_CODES.chatNotFound });
}

import { Injectable } from '@nestjs/common';
import {
  AI_LIMITS,
  type Chat,
  type ChatList,
  type ChatMessage,
  type ChatSummary,
} from '@homelab/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MESSAGE_FIELDS } from './assistant.constants.js';

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof MESSAGE_FIELDS }>;

/**
 * Chats and their messages (docs/plans/ai_assistant.md). Every read and write is by owner: a chat
 * of someone else is "not found", never shown. Contents are never logged.
 */
@Injectable()
export class ChatStore {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<ChatList> {
    const chats = await this.prisma.chat.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: AI_LIMITS.chatsListed,
      select: { id: true, title: true, model: true, updatedAt: true },
    });
    return { chats: chats.map(summary) };
  }

  async get(userId: string, id: string): Promise<Chat | null> {
    const chat = await this.prisma.chat.findFirst({
      where: { id, userId },
      include: { messages: { orderBy: { createdAt: 'asc' }, select: MESSAGE_FIELDS } },
    });
    if (!chat) return null;
    return {
      ...summary(chat),
      createdAt: chat.createdAt.toISOString(),
      messages: chat.messages.map(message),
    };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.chat.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  /** The question, saved: into a new chat (no `chatId`) or one of the owner's; null if not theirs. */
  async ask(
    userId: string,
    chatId: string | null,
    model: string,
    content: string,
  ): Promise<{ chat: ChatSummary; question: ChatMessage } | null> {
    let chat;
    if (chatId) {
      // The owner in the update itself: a chat deleted meanwhile is "not found", not an error.
      const { count } = await this.prisma.chat.updateMany({
        where: { id: chatId, userId },
        data: { model },
      });
      if (count === 0) return null;
      chat = await this.prisma.chat.findFirst({ where: { id: chatId, userId } });
      if (!chat) return null;
    } else {
      chat = await this.prisma.chat.create({ data: { userId, model, title: title(content) } });
    }
    const question = await this.prisma.chatMessage.create({
      data: { chatId: chat.id, role: 'user', content },
      select: MESSAGE_FIELDS,
    });
    return { chat: summary(chat), question: message(question) };
  }

  /** The conversation, oldest first. */
  async history(chatId: string): Promise<ChatMessage[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      select: MESSAGE_FIELDS,
    });
    return rows.map(message);
  }

  async answer(
    chatId: string,
    model: string,
    content: string,
    stopped: boolean,
  ): Promise<ChatMessage> {
    const [row] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: { chatId, role: 'assistant', content, model, stopped },
        select: MESSAGE_FIELDS,
      }),
      this.prisma.chat.update({ where: { id: chatId }, data: { model } }),
    ]);
    return message(row);
  }
}

/** The first line of the first message, shortened. */
export function title(content: string): string {
  const line = content.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > AI_LIMITS.titleMax ? `${line.slice(0, AI_LIMITS.titleMax - 1)}…` : line;
}

function summary(chat: { id: string; title: string; model: string; updatedAt: Date }): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    updatedAt: chat.updatedAt.toISOString(),
  };
}

function message(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    model: row.model,
    stopped: row.stopped,
    createdAt: row.createdAt.toISOString(),
  };
}

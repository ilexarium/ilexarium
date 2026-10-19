import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { HostModule } from '../host/host.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantTopic } from './assistant-topic.js';
import { ChatAnswers } from './chat-answers.js';
import { ChatStore } from './chat-store.js';
import { HfLibrary } from './hf-library.js';
import { ModelPulls } from './model-pulls.js';
import { OllamaService } from './ollama-service.js';

/**
 * The Assistant (docs/plans/ai_assistant.md): chats with local models run by the `ollama`
 * catalog service, model downloads (the `assistant` topic), Hugging Face search.
 */
@Module({
  imports: [AuditModule, HostModule, RealtimeModule],
  controllers: [AssistantController],
  providers: [AssistantTopic, ChatAnswers, ChatStore, HfLibrary, ModelPulls, OllamaService],
})
export class AssistantModule {}

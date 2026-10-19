import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  type HttpDownloadProgressEvent,
} from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
  type AiLibrary,
  type AiLibraryDetail,
  type AiModels,
  type AiPull,
  type AiStatus,
  type Chat,
  type ChatList,
  type ChatSend,
  type ChatStreamEvent,
  chatStreamEventSchema,
} from '@homelab/shared';
import { firstValueFrom, Observable } from 'rxjs';

/** The server's Assistant endpoints (docs/plans/ai_assistant.md). Downloads report through the `assistant` topic. */
@Service()
export class AssistantApi {
  private readonly http = inject(HttpClient);

  status(): Promise<AiStatus> {
    return firstValueFrom(this.http.get<AiStatus>('/api/assistant/status'));
  }

  models(): Promise<AiModels> {
    return firstValueFrom(this.http.get<AiModels>('/api/assistant/models'));
  }

  pull(model: string): Promise<AiPull> {
    return firstValueFrom(this.http.post<AiPull>('/api/assistant/models/pull', { model }));
  }

  removeModel(model: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>('/api/assistant/models', { params: { model } }));
  }

  search(search: string): Promise<AiLibrary> {
    return firstValueFrom(
      this.http.get<AiLibrary>('/api/assistant/library', { params: { search } }),
    );
  }

  /** `id` is `owner/repo`; each part goes into its own path segment. */
  libraryDetail(id: string): Promise<AiLibraryDetail> {
    const path = id.split('/').map(encodeURIComponent).join('/');
    return firstValueFrom(this.http.get<AiLibraryDetail>(`/api/assistant/library/${path}`));
  }

  chats(): Promise<ChatList> {
    return firstValueFrom(this.http.get<ChatList>('/api/assistant/chats'));
  }

  chat(id: string): Promise<Chat> {
    return firstValueFrom(this.http.get<Chat>(`/api/assistant/chats/${encodeURIComponent(id)}`));
  }

  removeChat(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/assistant/chats/${encodeURIComponent(id)}`));
  }

  /**
   * Sends a message; the answer arrives as it's written, one event per JSON line. Unsubscribing
   * stops it (the request is cancelled; the server keeps what was written). A refusal before the
   * answer starts errors with the server's `{ code }`, like any other call.
   */
  send(message: ChatSend): Observable<ChatStreamEvent> {
    return new Observable<ChatStreamEvent>((subscriber) => {
      let read = 0;
      const emit = (text: string, final: boolean) => {
        const end = final ? text.length : text.lastIndexOf('\n') + 1;
        for (const line of text.slice(read, end).split('\n')) {
          if (!line.trim()) continue;
          const event = chatStreamEventSchema.safeParse(JSON.parse(line));
          if (event.success) subscriber.next(event.data);
        }
        read = Math.max(read, end);
      };
      const subscription = this.http
        .post('/api/assistant/chat', message, {
          observe: 'events',
          reportProgress: true,
          responseType: 'text',
        })
        .subscribe({
          next: (event) => {
            if (event.type === HttpEventType.DownloadProgress) {
              emit((event as HttpDownloadProgressEvent).partialText ?? '', false);
            } else if (event.type === HttpEventType.Response) {
              emit(event.body ?? '', true);
              subscriber.complete();
            }
          },
          error: (error: unknown) => subscriber.error(withJsonBody(error)),
        });
      return () => subscription.unsubscribe();
    });
  }
}

/** A text response's error body parsed, so its `{ code }` reads like other calls'. */
function withJsonBody(error: unknown): unknown {
  if (!(error instanceof HttpErrorResponse) || typeof error.error !== 'string') return error;
  try {
    return new HttpErrorResponse({
      error: JSON.parse(error.error),
      headers: error.headers,
      status: error.status,
      statusText: error.statusText,
      url: error.url ?? undefined,
    });
  } catch {
    return error;
  }
}

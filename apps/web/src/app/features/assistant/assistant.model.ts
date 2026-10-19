import type { ChatMessage } from '@homelab/shared';

/** An answer being written: the text so far. */
export interface StreamingAnswer {
  text: string;
}

/** A message as the thread shows it: saved, or the one being written. */
export type ThreadMessage = ChatMessage | { id: 'streaming'; role: 'assistant'; content: string };

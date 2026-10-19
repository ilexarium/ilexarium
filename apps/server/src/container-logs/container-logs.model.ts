/** Whose log view a stream is: sign-out ends the session's streams (or the user's, "everywhere"). */
export interface LogViewer {
  readonly sessionId: string;
  readonly userId: string;
}

/** One container's logs, from the last `tail` lines or after `since` (a resumed view). */
export interface LogsRequest {
  readonly name: string;
  readonly tail: number;
  readonly since?: string;
}

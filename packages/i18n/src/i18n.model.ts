/** A language file: nested objects, strings at the leaves. */
export interface Messages {
  [key: string]: string | Messages;
}

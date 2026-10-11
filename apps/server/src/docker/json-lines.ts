/** A line longer than this is not a Docker event or stats frame — the stream is abandoned. */
const MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Docker's streaming endpoints (`/events`, `/containers/{id}/stats?stream=true`) send one JSON
 * object per line; chunks don't follow line boundaries. Yields each parsed object.
 */
export async function* jsonLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
    if (buffered.length > MAX_LINE_LENGTH) throw new Error('Docker stream line too long');
  }
  buffered += decoder.decode();
  if (buffered.trim()) yield JSON.parse(buffered);
}

/**
 * Server-sent events as both OpenAI-compatible and Anthropic endpoints send
 * them (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 * `event:` and `data:` fields, events separated by a blank line, any of
 * CRLF, LF or CR as line ends, comment lines starting with `:`.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  function* dispatchLine(line: string): Generator<SseEvent> {
    if (line === "") {
      if (data.length > 0) yield event === undefined ? { data: data.join("\n") } : { event, data: data.join("\n") };
      event = undefined;
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    const lineEnd = /\r\n|\r|\n/g;
    let consumed = 0;
    while ((match = lineEnd.exec(buffer)) !== null) {
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (match[0] === "\r" && match.index === buffer.length - 1) break;
      yield* dispatchLine(buffer.slice(consumed, match.index));
      consumed = match.index + match[0].length;
    }
    buffer = buffer.slice(consumed);
  }
  buffer += decoder.decode();
  if (buffer !== "") yield* dispatchLine(buffer);
  yield* dispatchLine("");
}

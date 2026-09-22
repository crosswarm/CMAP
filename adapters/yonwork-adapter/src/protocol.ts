import { TextDecoder } from "node:util";

import { AdapterError } from "#adapter-sdk";

export type YonWorkGatewayTerminalState = "final" | "error" | "aborted";

export interface YonWorkProtocolOptions {
  readonly expectedRunId: string;
  readonly expectedSessionKey: string;
  readonly maxFrameBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface YonWorkTerminal {
  readonly state: YonWorkGatewayTerminalState;
}

export interface YonWorkProtocolResult {
  readonly terminal?: YonWorkTerminal;
  readonly finalText?: string;
}

export type YonWorkProtocolEvent =
  | { readonly kind: "host_marker" }
  | { readonly kind: "ignored" }
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "terminal"; readonly state: YonWorkGatewayTerminalState };

type SseFrame = {
  readonly event: string;
  readonly data: string;
};

const HOST_EVENTS = new Set(["chat.run-id", "chat.complete", "chat.error"]);
const GATEWAY_EVENTS = new Set(["chat.message", "gateway:chat-message"]);
const TERMINAL_STATES = new Set(["final", "error", "aborted"]);

const err = (code: string, message: string): AdapterError =>
  new AdapterError(code, message, false, code.toLowerCase());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const hasTransport = (value: Record<string, unknown>): boolean =>
  value.runId !== undefined || value.sessionKey !== undefined || value.state !== undefined;

const splitPayload = (value: unknown): {
  readonly envelope: Record<string, unknown>;
  readonly assistant: Record<string, unknown>;
} => {
  if (!isRecord(value)) {
    throw err("YONWORK_PROTOCOL_INVALID", "YonWork frame payload is not an object");
  }
  const inner = value.message;

  if (hasTransport(value)) {
    if (isRecord(inner) && hasTransport(inner)) {
      for (const key of ["runId", "sessionKey", "state"]) {
        if (value[key] !== undefined && inner[key] !== undefined && value[key] !== inner[key]) {
          throw err("YONWORK_PROTOCOL_AMBIGUOUS", "YonWork frame has conflicting wrapper fields");
        }
      }
    }
    return { envelope: value, assistant: isRecord(inner) ? inner : value };
  }

  if (!isRecord(inner)) {
    return { envelope: value, assistant: value };
  }
  return { envelope: inner, assistant: isRecord(inner.message) ? inner.message : inner };
};

const textBlocks = (payload: Record<string, unknown>): string => {
  if (payload.role !== "assistant" || !Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
};

const parseFrame = (raw: string): SseFrame | undefined => {
  let event = "";
  const data: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return event ? { event, data: data.join("\n") } : undefined;
};

export class YonWorkSseReducer {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #options: Required<YonWorkProtocolOptions>;
  #buffer = "";
  #totalBytes = 0;
  #terminal?: YonWorkTerminal;
  #finalText?: string;

  constructor(options: YonWorkProtocolOptions) {
    this.#options = {
      ...options,
      maxFrameBytes: options.maxFrameBytes ?? 256 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 1024 * 1024,
    };
  }

  get result(): YonWorkProtocolResult {
    return {
      ...(this.#terminal ? { terminal: this.#terminal } : {}),
      ...(this.#finalText !== undefined ? { finalText: this.#finalText } : {}),
    };
  }

  push(chunk: string | Uint8Array): YonWorkProtocolEvent[] {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    this.#totalBytes += bytes;
    if (this.#totalBytes > this.#options.maxTotalBytes) {
      throw err("YONWORK_PROTOCOL_TOTAL_TOO_LARGE", "YonWork stream exceeded total byte limit");
    }

    try {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw err("YONWORK_PROTOCOL_INVALID_UTF8", "YonWork stream contains invalid UTF-8");
    }
    const events: YonWorkProtocolEvent[] = [];

    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.#buffer);
      if (!match?.index && match?.index !== 0) break;
      const end = match.index + match[0].length;
      const raw = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(end);
      if (Buffer.byteLength(raw) > this.#options.maxFrameBytes) {
        throw err("YONWORK_PROTOCOL_FRAME_TOO_LARGE", "YonWork SSE frame exceeded byte limit");
      }
      const frame = parseFrame(raw);
      if (frame) events.push(this.#accept(frame));
    }

    if (Buffer.byteLength(this.#buffer) > this.#options.maxFrameBytes) {
      throw err("YONWORK_PROTOCOL_FRAME_TOO_LARGE", "YonWork SSE frame exceeded byte limit");
    }
    return events;
  }

  finish(): void {
    try {
      this.#decoder.decode();
    } catch {
      throw err("YONWORK_PROTOCOL_INVALID_UTF8", "YonWork stream contains invalid UTF-8");
    }
    if (this.#buffer.length > this.#options.maxFrameBytes) {
      throw err("YONWORK_PROTOCOL_FRAME_TOO_LARGE", "YonWork SSE frame exceeded byte limit");
    }
  }

  #accept(frame: SseFrame): YonWorkProtocolEvent {
    if (HOST_EVENTS.has(frame.event)) {
      return { kind: "host_marker" };
    }
    if (!GATEWAY_EVENTS.has(frame.event) || this.#terminal) {
      return { kind: "ignored" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(frame.data);
    } catch {
      throw err("YONWORK_PROTOCOL_INVALID", "YonWork frame payload is not valid JSON");
    }
    const { envelope, assistant } = splitPayload(raw);
    if (envelope.runId !== this.#options.expectedRunId || envelope.sessionKey !== this.#options.expectedSessionKey) {
      return { kind: "ignored" };
    }

    const state = str(envelope.state);
    if (!TERMINAL_STATES.has(state ?? "")) {
      return { kind: "ignored" };
    }

    const text = textBlocks(assistant);
    if (text) {
      this.#finalText = text;
    }
    this.#terminal = { state: state as YonWorkGatewayTerminalState };
    return { kind: "terminal", state: this.#terminal.state };
  }
}

export const reduceYonWorkSse = (
  chunks: readonly (string | Uint8Array)[],
  options: YonWorkProtocolOptions,
): YonWorkProtocolResult => {
  const reducer = new YonWorkSseReducer(options);
  for (const chunk of chunks) reducer.push(chunk);
  reducer.finish();
  return reducer.result;
};

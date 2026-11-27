import { type FunctionDeclaration, GoogleGenAI, Modality, type Session } from "@google/genai";
import type { LiveSession, SessionFactory, ToolCall } from "./controller";
import { bytesToBase64 } from "./pcm";

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  systemInstruction: () => string | Promise<string>;
  tools: () => FunctionDeclaration[];
  /** Text of what the user said, in pieces. Used for phrase rules. */
  onInputTranscript?: (text: string) => void;
  /** The model finished its turn; the user's next words start a new turn. */
  onTurnEnd?: () => void;
}

/**
 * The Live WebSocket is served on v1beta; the SDK's default (v1) returns
 * HTTP 404 on the handshake.
 */
const LIVE_API_VERSION = "v1beta";

/** WebSocket close code for a normal shutdown. */
const NORMAL_CLOSURE = 1000;

/** Creates sessions against the Gemini Live API (audio in, audio out). */
export function createGeminiSessionFactory(options: GeminiLiveOptions): SessionFactory {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { apiVersion: LIVE_API_VERSION },
  });

  return async (handlers) => {
    const functionDeclarations = options.tools();
    const session: Session = await ai.live.connect({
      model: options.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
        systemInstruction: await options.systemInstruction(),
        inputAudioTranscription: {},
        // Google Search runs on Gemini's side, so it is not a registry tool.
        tools: [
          { googleSearch: {} },
          ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
        ],
      },
      callbacks: {
        onmessage: (message) => {
          const content = message.serverContent;
          for (const part of content?.modelTurn?.parts ?? []) {
            const data = part.inlineData?.data;
            if (data && part.inlineData?.mimeType?.startsWith("audio/")) handlers.onAudio(data);
          }
          if (content?.interrupted) handlers.onInterrupted();
          const transcript = content?.inputTranscription?.text;
          if (transcript) options.onInputTranscript?.(transcript);
          if (content?.turnComplete) {
            handlers.onTurnComplete();
            options.onTurnEnd?.();
          }

          const calls: ToolCall[] = (message.toolCall?.functionCalls ?? []).map((call) => ({
            id: call.id ?? "",
            name: call.name ?? "",
            args: call.args ?? {},
          }));
          if (calls.length > 0) handlers.onToolCalls(calls);
        },
        onerror: (event) => handlers.onClose(event.message || "Connection error."),
        onclose: (event) =>
          handlers.onClose(
            event.code === NORMAL_CLOSURE
              ? ""
              : event.reason || `Connection closed (${event.code}).`,
          ),
      },
    });

    const live: LiveSession = {
      sendAudio: (pcm) =>
        session.sendRealtimeInput({
          audio: { data: bytesToBase64(new Uint8Array(pcm)), mimeType: "audio/pcm;rate=16000" },
        }),
      endAudioStream: () => session.sendRealtimeInput({ audioStreamEnd: true }),
      sendToolResponses: (responses) => session.sendToolResponse({ functionResponses: responses }),
      close: () => session.close(),
    };
    return live;
  };
}

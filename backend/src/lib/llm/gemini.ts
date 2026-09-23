import { GoogleGenAI } from "@google/genai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";
import {
    assertFinalSynthesisResult,
    buildToolLoopIteration,
    normalizeMaxToolIterations,
    throwIfAborted,
} from "./types";
import { toGeminiTools } from "./tools";

type GeminiPart = {
    text?: string;
    inlineData?: { mimeType: string; data: string };
    // Set by Gemini when the text content is a thought summary rather than
    // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
    thought?: boolean;
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
    // Gemini 3 returns built-in tool activity in these parts when
    // includeServerSideToolInvocations is enabled. Keep each part intact for
    // the next function-call iteration, including its thoughtSignature.
    toolCall?: Record<string, unknown>;
    toolResponse?: Record<string, unknown>;
    executableCode?: Record<string, unknown>;
    codeExecutionResult?: Record<string, unknown>;
    // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
    // a functionCall. It must be echoed back verbatim on the same part when
    // we replay the model's turn, or the API rejects the next call.
    thoughtSignature?: string;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

function client(override?: string | null): GoogleGenAI {
    const apiKey = override?.trim() || process.env.GEMINI_API_KEY || "";
    return new GoogleGenAI({ apiKey });
}

function toNativeContents(messages: StreamChatParams["messages"]): GeminiContent[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
            { text: m.content },
            ...(m.role === "user"
                ? (m.media ?? []).map((media) => ({
                      inlineData: {
                          mimeType: media.mimeType,
                          data: media.base64Data,
                      },
                  }))
                : []),
        ],
    }));
}

function groundingUrls(chunk: unknown): { url: string; title: string }[] {
    const candidate = (chunk as {
        candidates?: {
            groundingMetadata?: {
                groundingChunks?: {
                    web?: { uri?: string; title?: string };
                    retrievedContext?: { uri?: string; title?: string };
                }[];
            };
            urlContextMetadata?: {
                urlMetadata?: {
                    retrievedUrl?: string;
                    urlRetrievalStatus?: string;
                }[];
            };
        }[];
    })?.candidates?.[0];
    const urls: { url: string; title: string }[] = [];
    for (const source of candidate?.groundingMetadata?.groundingChunks ?? []) {
        const item = source.web ?? source.retrievedContext;
        if (!item?.uri) continue;
        try {
            const url = new URL(item.uri);
            if (url.protocol !== "https:" && url.protocol !== "http:") continue;
            urls.push({ url: url.toString(), title: item.title?.trim() || url.hostname });
        } catch {
            // Ignore malformed provider metadata rather than emitting a bad link.
        }
    }
    for (const item of candidate?.urlContextMetadata?.urlMetadata ?? []) {
        if (!item.retrievedUrl || item.urlRetrievalStatus?.includes("ERROR")) continue;
        try {
            const url = new URL(item.retrievedUrl);
            if (url.protocol !== "https:" && url.protocol !== "http:") continue;
            urls.push({ url: url.toString(), title: url.hostname });
        } catch {
            // Ignore malformed provider metadata.
        }
    }
    return urls;
}

export async function streamGemini(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools, apiKeys, enableThinking } = params;
    const maxToolIterations = normalizeMaxToolIterations(
        params.maxIterations,
    );
    const ai = client(apiKeys?.gemini);
    const functionDeclarations = toGeminiTools(tools);

    const contents: GeminiContent[] = toNativeContents(params.messages);
    let fullText = "";
    const sources = new Map<string, string>();

    for (let iter = 0; iter <= maxToolIterations; iter++) {
        throwIfAborted(params.abortSignal);
        const iterationPlan = buildToolLoopIteration(
            iter,
            maxToolIterations,
            functionDeclarations,
            systemPrompt,
        );
        const {
            finalSynthesis,
            tools: iterationTools,
            systemPrompt: iterationSystemPrompt,
        } = iterationPlan;
        const stream = await ai.models.generateContentStream({
            model,
            contents: contents as never,
            config: {
                systemInstruction: iterationSystemPrompt,
                tools: finalSynthesis
                    ? undefined
                    : [
                          { googleSearch: {} },
                          { urlContext: {} },
                          { codeExecution: {} },
                          ...(iterationTools.length
                              ? [{ functionDeclarations: iterationTools }]
                              : []),
                      ],
                toolConfig: finalSynthesis
                    ? undefined
                    : { includeServerSideToolInvocations: true },
                // When enabled, ask Gemini to surface thought summaries.
                // When disabled, explicitly zero the thinking budget so the
                // model skips thinking entirely (saves tokens and latency
                // for bulk extraction jobs).
                thinkingConfig: enableThinking
                    ? { includeThoughts: true }
                    : { thinkingBudget: 0 },
                abortSignal: params.abortSignal,
            },
        });

        // Per-iteration accumulators.
        const textParts: string[] = [];
        const modelParts: GeminiPart[] = [];
        const toolCalls: NormalizedToolCall[] = [];
        let sawThinking = false;

        const iterator = stream[Symbol.asyncIterator]();
        let rejectAbort: ((reason?: unknown) => void) | null = null;
        const abortPromise = new Promise<never>((_, reject) => {
            rejectAbort = reject;
        });
        const onAbort = () => {
            const error = new Error("Stream aborted.");
            error.name = "AbortError";
            rejectAbort?.(error);
        };
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });

        try {
            while (true) {
                throwIfAborted(params.abortSignal);
                const { value: chunk, done } = await Promise.race([
                    iterator.next(),
                    abortPromise,
                ]);
                if (done) break;

                for (const source of groundingUrls(chunk)) {
                    sources.set(source.url, source.title);
                }

                const parts =
                    (
                        chunk as {
                            candidates?: {
                                content?: { parts?: GeminiPart[] };
                            }[];
                        }
                    ).candidates?.[0]?.content?.parts ?? [];

                for (const part of parts) {
                    modelParts.push(part);
                    if (part.text) {
                        if (part.thought) {
                            sawThinking = true;
                            callbacks.onReasoningDelta?.(part.text);
                        } else {
                            textParts.push(part.text);
                            callbacks.onContentDelta?.(part.text);
                        }
                    }
                    if (part.functionCall) {
                        const call: NormalizedToolCall = {
                            id:
                                part.functionCall.id ??
                                `${part.functionCall.name}-${toolCalls.length}`,
                            name: part.functionCall.name,
                            input: part.functionCall.args ?? {},
                        };
                        callbacks.onToolCallStart?.(call);
                        toolCalls.push(call);
                    }
                }
            }
        } finally {
            params.abortSignal?.removeEventListener("abort", onAbort);
            if (params.abortSignal?.aborted) {
                try {
                    await iterator.return?.(undefined);
                } catch {
                    // Preserve the normalized cancellation error from the race.
                }
            }
        }

        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        throwIfAborted(params.abortSignal);

        fullText += textParts.join("");

        if (finalSynthesis) {
            assertFinalSynthesisResult("gemini", {
                text: textParts.join(""),
                toolCallCount: toolCalls.length,
            });
            break;
        }
        if (!toolCalls.length) break;
        if (!runTools) {
            throw new Error(
                "Gemini requested a tool, but no tool executor is available.",
            );
        }

        throwIfAborted(params.abortSignal);
        const results = await runTools(toolCalls);
        throwIfAborted(params.abortSignal);

        // Preserve Gemini's original text, built-in tool activity, function
        // calls and thought signatures. Reconstructing this from the visible
        // answer would break Gemini 3's built-in/custom-tool combination.
        contents.push({ role: "model", parts: modelParts });

        contents.push({
            role: "user",
            parts: results.map((r) => {
                const match = toolCalls.find((c) => c.id === r.tool_use_id);
                return {
                    functionResponse: {
                        ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                            ? { id: r.tool_use_id }
                            : {}),
                        name: match?.name ?? "tool",
                        response: { output: r.content },
                    },
                };
            }),
        });
    }

    if (sources.size) {
        const links = [...sources].slice(0, 12).map(([url, title], index) => {
            const label = title.replace(/[\[\]\\\r\n]/g, " ").slice(0, 100);
            return `${index + 1}. [${label}](${url})`;
        });
        const sourceText = `\n\nSources:\n${links.join("\n")}`;
        fullText += sourceText;
        if (params.callbacks?.onSources) params.callbacks.onSources(sourceText);
        else params.callbacks?.onContentDelta?.(sourceText);
    }

    return { fullText };
}

export async function completeGeminiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    apiKeys?: { gemini?: string | null };
}): Promise<string> {
    const ai = client(params.apiKeys?.gemini);
    const resp = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.user }] }],
        config: params.systemPrompt
            ? { systemInstruction: params.systemPrompt }
            : undefined,
    });
    return resp.text ?? "";
}

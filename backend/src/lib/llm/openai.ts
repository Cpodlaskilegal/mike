import OpenAI from "openai";
import type {
    Response,
    ResponseFunctionToolCall,
    ResponseInput,
    ResponseInputItem,
    ResponseStreamEvent,
    ResponseTextConfig,
    Tool,
} from "openai/resources/responses/responses";
import type {
    JsonSchemaTextFormat,
    NormalizedToolCall,
    ReasoningEffort,
    StreamChatParams,
    StreamChatResult,
    TextVerbosity,
} from "./types";

const MAX_OUTPUT_TOKENS = 16384;

function client(): OpenAI {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error(
            "OPENAI_API_KEY is required to use OpenAI models. Configure the server-managed key before selecting an OpenAI model.",
        );
    }
    return new OpenAI({ apiKey });
}

function isProModel(model: string): boolean {
    return model === "gpt-5.5-pro";
}

function defaultReasoningEffort(
    model: string,
    enableThinking?: boolean,
): ReasoningEffort {
    // OpenAI pro models are explicitly high-reasoning/non-streaming. For the
    // normal chat surface, mirror Claude/Gemini by spending reasoning only
    // where the UI is prepared to show it; extraction and short generated text
    // stay lean unless a caller overrides this.
    if (isProModel(model)) return "high";
    if (enableThinking) {
        if (model.endsWith("-mini") || model.endsWith("-nano")) return "low";
        return "medium";
    }
    if (model.endsWith("-nano")) return "minimal";
    return "low";
}

function reasoningForModel(
    model: string,
    reasoningEffort?: ReasoningEffort,
    enableThinking?: boolean,
) {
    return {
        effort: reasoningEffort ?? defaultReasoningEffort(model, enableThinking),
    };
}

function textConfig(
    textVerbosity?: TextVerbosity,
    textFormat?: JsonSchemaTextFormat,
): ResponseTextConfig | undefined {
    if (!textVerbosity && !textFormat) return undefined;
    const config: ResponseTextConfig = {};
    if (textVerbosity) config.verbosity = textVerbosity;
    if (textFormat) {
        config.format = {
            type: "json_schema",
            name: textFormat.name,
            description: textFormat.description,
            schema: textFormat.schema,
            strict: textFormat.strict,
        };
    }
    return config;
}

function toInput(messages: StreamChatParams["messages"]): ResponseInput {
    return messages.map((m) => ({
        type: "message",
        role: m.role,
        content: [{ type: "input_text", text: m.content }],
    }));
}

function toOpenAITools(tools: StreamChatParams["tools"] = []): Tool[] {
    return tools.map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: false,
    }));
}

function parseToolArguments(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function extractFunctionCalls(response: Response): ResponseFunctionToolCall[] {
    return response.output.filter(
        (item): item is ResponseFunctionToolCall =>
            item.type === "function_call" && item.status !== "incomplete",
    );
}

function outputText(response: Response): string {
    return response.output_text ?? "";
}

async function createStreamingResponse(
    openai: OpenAI,
    params: {
        model: string;
        systemPrompt: string;
        input: ResponseInput;
        tools: Tool[];
        previousResponseId?: string;
        enableThinking?: boolean;
        reasoningEffort?: ReasoningEffort;
        textVerbosity?: TextVerbosity;
        textFormat?: JsonSchemaTextFormat;
        onDelta?: (delta: string) => void;
        onReasoningDelta?: (delta: string) => void;
        onReasoningBlockEnd?: () => void;
    },
): Promise<Response> {
    const stream = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools.length ? params.tools : undefined,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(
            params.model,
            params.reasoningEffort,
            params.enableThinking,
        ),
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
        stream: true,
    });

    let final: Response | null = null;
    let reasoningOpen = false;
    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        if (event.type === "response.output_text.delta") {
            params.onDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta")
        ) {
            reasoningOpen = true;
            params.onReasoningDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.done" ||
                event.type === "response.reasoning_text.done")
        ) {
            if (reasoningOpen) {
                params.onReasoningBlockEnd?.();
                reasoningOpen = false;
            }
        } else if (event.type === "response.completed") {
            final = event.response;
        } else if (event.type === "response.failed") {
            throw new Error(event.response.error?.message ?? "OpenAI response failed");
        } else if (event.type === "response.incomplete") {
            throw new Error(
                event.response.incomplete_details?.reason ??
                    "OpenAI response incomplete",
            );
        } else if (event.type === "error") {
            throw new Error(event.message);
        }
    }
    if (!final) throw new Error("OpenAI stream ended without a completed response");
    return final;
}

async function createNonStreamingResponse(
    openai: OpenAI,
    params: {
        model: string;
        systemPrompt?: string;
        input: string | ResponseInput;
        tools?: Tool[];
        previousResponseId?: string;
        maxTokens?: number;
        enableThinking?: boolean;
        reasoningEffort?: ReasoningEffort;
        textVerbosity?: TextVerbosity;
        textFormat?: JsonSchemaTextFormat;
    },
): Promise<Response> {
    const response = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools?.length ? params.tools : undefined,
        max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(
            params.model,
            params.reasoningEffort,
            params.enableThinking,
        ),
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
        stream: false,
    });
    if (response.status === "failed") {
        throw new Error(response.error?.message ?? "OpenAI response failed");
    }
    if (response.status === "incomplete") {
        throw new Error(
            response.incomplete_details?.reason ?? "OpenAI response incomplete",
        );
    }
    return response;
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const openai = client();
    const openaiTools = toOpenAITools(tools);
    let input = toInput(params.messages);
    let previousResponseId: string | undefined;
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const beforeLength = fullText.length;
        const response = isProModel(model)
            ? await createNonStreamingResponse(openai, {
                  model,
                  systemPrompt,
                  input,
                  tools: openaiTools,
                  previousResponseId,
                  enableThinking: params.enableThinking,
                  reasoningEffort: params.reasoningEffort,
                  textVerbosity: params.textVerbosity,
                  textFormat: params.textFormat,
              })
            : await createStreamingResponse(openai, {
                  model,
                  systemPrompt,
                  input,
                  tools: openaiTools,
                  previousResponseId,
                  enableThinking: params.enableThinking,
                  reasoningEffort: params.reasoningEffort,
                  textVerbosity: params.textVerbosity,
                  textFormat: params.textFormat,
                  onDelta: (delta) => {
                      fullText += delta;
                      callbacks.onContentDelta?.(delta);
                  },
                  onReasoningDelta: callbacks.onReasoningDelta,
                  onReasoningBlockEnd: callbacks.onReasoningBlockEnd,
              });

        previousResponseId = response.id;
        if (isProModel(model)) {
            const text = outputText(response);
            fullText += text;
            callbacks.onContentDelta?.(text);
        } else if (fullText.length === beforeLength) {
            const text = outputText(response);
            if (text) {
                fullText += text;
                callbacks.onContentDelta?.(text);
            }
        }

        const calls = extractFunctionCalls(response);
        if (!calls.length || !runTools) break;

        const normalizedCalls: NormalizedToolCall[] = calls.map((call) => ({
            id: call.call_id,
            name: call.name,
            input: parseToolArguments(call.arguments),
        }));
        for (const call of normalizedCalls) callbacks.onToolCallStart?.(call);

        const results = await runTools(normalizedCalls);
        input = results.map((result): ResponseInputItem => ({
            type: "function_call_output",
            call_id: result.tool_use_id,
            output: result.content,
        }));
    }

    return { fullText };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    reasoningEffort?: ReasoningEffort;
    textVerbosity?: TextVerbosity;
    textFormat?: JsonSchemaTextFormat;
}): Promise<string> {
    const openai = client();
    const response = await createNonStreamingResponse(openai, {
        model: params.model,
        systemPrompt: params.systemPrompt,
        input: params.user,
        maxTokens: params.maxTokens ?? 512,
        reasoningEffort: params.reasoningEffort,
        textVerbosity: params.textVerbosity,
        textFormat: params.textFormat,
    });
    return outputText(response);
}

import OpenAI from "openai";
import type {
    Response,
    ResponseFunctionToolCall,
    ResponseInput,
    ResponseInputItem,
    ResponseStreamEvent,
    Tool,
} from "openai/resources/responses/responses";
import type {
    NormalizedToolCall,
    StreamChatParams,
    StreamChatResult,
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

function reasoningForModel(model: string) {
    if (model.endsWith("-pro")) return { effort: "high" as const };
    if (model.endsWith("-mini") || model.endsWith("-nano")) {
        return { effort: "low" as const };
    }
    return { effort: "medium" as const };
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
        onDelta?: (delta: string) => void;
    },
): Promise<Response> {
    const stream = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools.length ? params.tools : undefined,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(params.model),
        parallel_tool_calls: true,
        stream: true,
    });

    let final: Response | null = null;
    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        if (event.type === "response.output_text.delta") {
            params.onDelta?.(event.delta);
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
    },
): Promise<Response> {
    const response = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools?.length ? params.tools : undefined,
        max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(params.model),
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
              })
            : await createStreamingResponse(openai, {
                  model,
                  systemPrompt,
                  input,
                  tools: openaiTools,
                  previousResponseId,
                  onDelta: (delta) => {
                      fullText += delta;
                      callbacks.onContentDelta?.(delta);
                  },
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
}): Promise<string> {
    const openai = client();
    const response = await createNonStreamingResponse(openai, {
        model: params.model,
        systemPrompt: params.systemPrompt,
        input: params.user,
        maxTokens: params.maxTokens ?? 512,
    });
    return outputText(response);
}

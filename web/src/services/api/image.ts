import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { withOpenAIPromptCacheKey } from "@/lib/openai-prompt-cache";

import type { AiTextMessage, RequestOptions, ResponseFunctionTool, ResponseInputMessage, ToolChoice, ToolResponseResult } from "@/services/api/image-contracts";
import { readAxiosError } from "@/services/api/image-response";
import { toChatCompletionMessages, toChatCompletionToolChoice, toClaudeBody, toGeminiBody, toGeminiToolOptions, toResponseInput, toResponseTool, withSystemMessage } from "@/services/api/image-protocols";
import { requestGeminiStreamingResponse, requestStreamingChatCompletion, requestStreamingClaude, requestStreamingResponse } from "@/services/api/image-streaming";
export { buildBackendToolRequests } from "@/services/api/image-protocols";
export type { AiTextContentPart, AiTextMessage, ResponseFunctionTool, ResponseInputMessage, ResponseToolCall, ToolChoice, ToolResponseResult } from "@/services/api/image-contracts";

function isToolChoiceCompatibilityError(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    return /tool[_\s-]?choice|thinking\s+mode/i.test(message);
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        if (requestConfig.interfaceType === "claude-api") {
            const answer = (await requestStreamingClaude(requestConfig, toClaudeBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        if (requestConfig.interfaceType === "chat-completion" || !requestConfig.interfaceType) {
            const answer =
                (
                    await requestStreamingChatCompletion(
                        requestConfig,
                        {
                            model: requestConfig.model,
                            messages: toChatCompletionMessages(withSystemMessage(requestConfig, messages)),
                        },
                        onDelta,
                        options,
                    )
                ).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        const answer =
            (
                await requestStreamingResponse(
                    requestConfig,
                    {
                        model: requestConfig.model,
                        input: toResponseInput(withSystemMessage(requestConfig, messages)),
                    },
                    onDelta,
                    options,
                )
            ).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    try {
        if (requestConfig.apiFormat === "gemini") {
            return await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages, toGeminiToolOptions(tools, toolChoice)), onDelta, options);
        }
        if (requestConfig.interfaceType === "claude-api") return await requestStreamingClaude(requestConfig, toClaudeBody(requestConfig, messages, tools), onDelta, options);
        if (requestConfig.interfaceType === "chat-completion" || !requestConfig.interfaceType) {
            const chatPayload: Record<string, unknown> = {
                model: requestConfig.model,
                messages: toChatCompletionMessages(withSystemMessage(requestConfig, messages)),
                tools,
                tool_choice: toChatCompletionToolChoice(toolChoice),
                parallel_tool_calls: false,
            };
            try {
                return await requestStreamingChatCompletion(requestConfig, chatPayload, onDelta, options);
            } catch (error) {
                if (!isToolChoiceCompatibilityError(error)) throw error;

                // 部分 OpenAI 兼容上游仅支持 auto，思考模式则可能要求完全省略该字段。
                if (toolChoice !== "auto") {
                    try {
                        return await requestStreamingChatCompletion(requestConfig, { ...chatPayload, tool_choice: toChatCompletionToolChoice("auto") }, onDelta, options);
                    } catch (autoError) {
                        if (!isToolChoiceCompatibilityError(autoError)) throw autoError;
                    }
                }
                const { tool_choice: _ignored, ...withoutToolChoice } = chatPayload;
                void _ignored;
                return await requestStreamingChatCompletion(requestConfig, withoutToolChoice, onDelta, options);
            }
        }
        return await requestStreamingResponse(
            requestConfig,
            withOpenAIPromptCacheKey(
                {
                    model: requestConfig.model,
                    input: toResponseInput(withSystemMessage(requestConfig, messages)),
                    tools: tools.map(toResponseTool),
                    tool_choice: toolChoice,
                    parallel_tool_calls: false,
                },
                options?.promptCacheKey,
            ),
            onDelta,
            options,
        );
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export { fetchChannelModels, fetchImageModels } from "@/services/api/image-models";
export type { ChannelModelFetchResult } from "@/services/api/image-models";

"use client";

import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { InitialView } from "@/app/components/assistant/InitialView";
import { ChatView } from "@/app/components/assistant/ChatView";
import type { DocketMessage } from "@/app/components/shared/types";

export default function AssistantPage() {
    const { messages, isResponseLoading, handleChat, cancel } =
        useAssistantChat();

    async function handleInitialSubmit(message: DocketMessage) {
        await handleChat(message);
    }

    if (messages.length === 0) {
        return (
            <InitialView
                onSubmit={(message) => void handleInitialSubmit(message)}
            />
        );
    }

    return (
        <ChatView
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
        />
    );
}

"use client";

import { useState } from "react";

import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { InitialView } from "@/app/components/assistant/InitialView";
import { ChatView } from "@/app/components/assistant/ChatView";
import type { DocketMessage } from "@/app/components/shared/types";
import { preflightDraftFromResult } from "@/app/lib/assistantRecovery";

export default function AssistantPage() {
    const [preflightDraft, setPreflightDraft] = useState<DocketMessage | null>(null);
    const { messages, isResponseLoading, handleChat, submitAskInputs, cancel } =
        useAssistantChat();

    async function handleInitialSubmit(message: DocketMessage) {
        const result = await handleChat(message);
        setPreflightDraft(preflightDraftFromResult(result, message));
        return result;
    }

    if (messages.length === 0) {
        return (
            <InitialView
                onSubmit={handleInitialSubmit}
                recoveryDraft={preflightDraft}
            />
        );
    }

    return (
        <ChatView
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            onAskInputsSubmit={submitAskInputs}
            recoveryDraft={preflightDraft}
            cancel={cancel}
        />
    );
}

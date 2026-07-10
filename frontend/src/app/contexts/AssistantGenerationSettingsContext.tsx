"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useState,
    type ReactNode,
} from "react";
import {
    ASSISTANT_GENERATION_STORAGE_KEY,
    LEGACY_ASSISTANT_MODEL_STORAGE_KEY,
    activateAssistantSession,
    adoptCreatedAssistantChat,
    defaultAssistantGenerationSettings,
    deserializeAssistantGenerationSettings,
    effectiveAssistantGenerationSettings,
    persistAssistantGenerationSettings,
    selectAssistantEffort,
    selectAssistantModel,
    setAssistantReasoningMode,
    type AssistantGenerationSettingsState,
    type AssistantReasoningMode,
    type EffectiveAssistantGenerationSettings,
    type Gpt56ReasoningEffort,
} from "@/app/lib/assistantGenerationSettings";

type SettingsAction =
    | { type: "hydrate"; state: AssistantGenerationSettingsState }
    | { type: "select_model"; model: string }
    | { type: "select_effort"; effort: Gpt56ReasoningEffort }
    | { type: "set_mode"; mode: AssistantReasoningMode }
    | { type: "activate_session"; sessionKey: string }
    | { type: "adopt_created_chat"; sessionKey: string };

function settingsReducer(
    state: AssistantGenerationSettingsState,
    action: SettingsAction,
): AssistantGenerationSettingsState {
    switch (action.type) {
        case "hydrate":
            return action.state;
        case "select_model":
            return selectAssistantModel(state, action.model);
        case "select_effort":
            return selectAssistantEffort(state, action.effort);
        case "set_mode":
            return setAssistantReasoningMode(state, action.mode);
        case "activate_session":
            return activateAssistantSession(state, action.sessionKey);
        case "adopt_created_chat":
            return adoptCreatedAssistantChat(state, action.sessionKey);
    }
}

type AssistantGenerationSettingsContextValue = {
    state: AssistantGenerationSettingsState;
    effectiveSettings: EffectiveAssistantGenerationSettings;
    hydrated: boolean;
    selectModel: (model: string) => void;
    selectEffort: (effort: Gpt56ReasoningEffort) => void;
    setReasoningMode: (mode: AssistantReasoningMode) => void;
    activateSession: (sessionKey: string) => void;
    adoptCreatedChat: (sessionKey: string) => void;
};

const AssistantGenerationSettingsContext =
    createContext<AssistantGenerationSettingsContextValue | null>(null);

export function AssistantGenerationSettingsProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [state, dispatch] = useReducer(
        settingsReducer,
        undefined,
        defaultAssistantGenerationSettings,
    );
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        let next = defaultAssistantGenerationSettings();
        if (typeof window !== "undefined") {
            try {
                const storage = window.localStorage;
                next = deserializeAssistantGenerationSettings({
                    versioned: storage.getItem(
                        ASSISTANT_GENERATION_STORAGE_KEY,
                    ),
                    legacy: storage.getItem(
                        LEGACY_ASSISTANT_MODEL_STORAGE_KEY,
                    ),
                });
            } catch {
                // Storage can be unavailable in private or restricted browser
                // contexts. The in-memory Sol/Medium/Standard state is safe.
            }
        }
        dispatch({ type: "hydrate", state: next });
        setHydrated(true);
    }, []);

    useEffect(() => {
        if (!hydrated || typeof window === "undefined") return;
        try {
            persistAssistantGenerationSettings(window.localStorage, state);
        } catch {
            // Keep chat usable when the browser denies storage access.
        }
    }, [hydrated, state]);

    const selectModel = useCallback((model: string) => {
        dispatch({ type: "select_model", model });
    }, []);
    const selectEffort = useCallback((effort: Gpt56ReasoningEffort) => {
        dispatch({ type: "select_effort", effort });
    }, []);
    const setReasoningMode = useCallback((mode: AssistantReasoningMode) => {
        dispatch({ type: "set_mode", mode });
    }, []);
    const activateSession = useCallback((sessionKey: string) => {
        dispatch({ type: "activate_session", sessionKey });
    }, []);
    const adoptCreatedChat = useCallback((sessionKey: string) => {
        dispatch({ type: "adopt_created_chat", sessionKey });
    }, []);

    const effectiveSettings = useMemo(
        () => effectiveAssistantGenerationSettings(state),
        [state],
    );
    const value = useMemo<AssistantGenerationSettingsContextValue>(
        () => ({
            state,
            effectiveSettings,
            hydrated,
            selectModel,
            selectEffort,
            setReasoningMode,
            activateSession,
            adoptCreatedChat,
        }),
        [
            state,
            effectiveSettings,
            hydrated,
            selectModel,
            selectEffort,
            setReasoningMode,
            activateSession,
            adoptCreatedChat,
        ],
    );

    return (
        <AssistantGenerationSettingsContext.Provider value={value}>
            {children}
        </AssistantGenerationSettingsContext.Provider>
    );
}

export function useAssistantGenerationSettings(): AssistantGenerationSettingsContextValue {
    const context = useContext(AssistantGenerationSettingsContext);
    if (!context) {
        throw new Error(
            "useAssistantGenerationSettings must be used inside AssistantGenerationSettingsProvider",
        );
    }
    return context;
}

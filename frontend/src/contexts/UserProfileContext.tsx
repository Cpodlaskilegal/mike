"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    getUserProfile,
    updateUserProfile,
    type MikeUserProfile,
} from "@/app/lib/mikeApi";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiEnabled: boolean;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

function mapProfile(data: MikeUserProfile): UserProfile {
    const creditsUsed = data.message_credits_used ?? 0;
    return {
        displayName: data.display_name,
        organisation: data.organisation ?? null,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: data.credits_reset_date,
        creditsRemaining: MONTHLY_CREDIT_LIMIT - creditsUsed,
        tier: data.tier || "Free",
        tabularModel: data.tabular_model || "gpt-5.4-mini",
        claudeApiKey: data.claude_api_key ?? null,
        geminiApiKey: data.gemini_api_key ?? null,
        openaiEnabled: !!data.openai_enabled,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const data = await getUserProfile();

            // Use fetched data to update profile state
            if (data) {
                let creditsUsed = data.message_credits_used;
                let resetDate = data.credits_reset_date;
                let shouldUpdateDb = false;

                // Check if credits have expired and need reset
                if (resetDate && new Date() > new Date(resetDate)) {
                    // Calculate new reset date
                    const newResetDate = new Date();
                    newResetDate.setDate(newResetDate.getDate() + 30);
                    resetDate = newResetDate.toISOString();
                    creditsUsed = 0;
                    shouldUpdateDb = true;
                }

                // 1. Update local state immediately
                setProfile(
                    mapProfile({
                        ...data,
                        message_credits_used: creditsUsed,
                        credits_reset_date: resetDate,
                    }),
                );

                // 2. Update database in background if needed
                if (shouldUpdateDb) {
                    updateUserProfile({
                        message_credits_used: 0,
                        credits_reset_date: resetDate,
                    }).catch((error) =>
                        console.error("Failed to auto-reset credits", error),
                    );
                }
            }
        } catch (e) {
            console.error("[profile] failed to load user profile", e);
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                tabularModel: "gpt-5.4-mini",
                claudeApiKey: null,
                geminiApiKey: null,
                openaiEnabled: false,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                const updated = await updateUserProfile({ display_name: displayName });
                setProfile(mapProfile(updated));
                return true;
            } catch (error) {
                console.error("[profile] failed to update display name", error);
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ organisation });
                setProfile(mapProfile(updated));
                return true;
            } catch (error) {
                console.error("[profile] failed to update organisation", error);
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            try {
                const updated = await updateUserProfile({ [dbField]: value });
                setProfile(mapProfile(updated));
                return true;
            } catch (error) {
                console.error("[profile] failed to update model preference", {
                    field,
                    value,
                    error,
                });
                return false;
            }
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField =
                provider === "claude" ? "claude_api_key" : "gemini_api_key";
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const updated = await updateUserProfile({ [dbField]: normalized });
                setProfile(mapProfile(updated));
                return true;
            } catch (error) {
                console.error(`[profile] failed to save ${provider} API key`, error);
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile();
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        try {
            const newCreditsUsed = profile.messageCreditsUsed + 1;

            const updated = await updateUserProfile({ message_credits_used: newCreditsUsed });
            setProfile(mapProfile(updated));

            return true;
        } catch (err) {
            console.error("[profile] failed to increment message credits", err);
            return false;
        }
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}

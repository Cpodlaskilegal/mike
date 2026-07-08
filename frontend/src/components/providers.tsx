"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { BoxAuthGate } from "@/components/BoxAuthGate";
import { PostHogAnalytics } from "@/components/PostHogAnalytics";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <UserProfileProvider>
                <PostHogAnalytics>
                    <BoxAuthGate>{children}</BoxAuthGate>
                </PostHogAnalytics>
            </UserProfileProvider>
        </AuthProvider>
    );
}

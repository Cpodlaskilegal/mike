"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { BoxAuthGate } from "@/components/BoxAuthGate";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <UserProfileProvider>
                <BoxAuthGate>{children}</BoxAuthGate>
            </UserProfileProvider>
        </AuthProvider>
    );
}

"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";

interface User {
    id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    useEffect(() => {
        const ensureProfile = async (accessToken: string) => {
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            await fetch(`${apiBase}/user/profile`, {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}` },
            }).catch((error) => {
                console.error("[auth] failed to ensure profile", error);
            });
        };

        const checkUser = async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession({ interactive: true });

                if (session?.user) {
                    setUser({
                        id: session.user.id,
                        email: session.user.email || "",
                    });
                    ensureProfile(session.access_token);
                } else {
                    setUser(null);
                }
            } catch (error) {
                console.error("[auth] failed to initialize", error);
                setUser(null);
            } finally {
                setAuthLoading(false);
            }
        };

        checkUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === "LOGOUT_SUCCESS" || event === "AUTH_INIT_FAILED") {
                setUser(null);
                setAuthLoading(false);
                return;
            }
            if (session?.user) {
                setUser({
                    id: session.user.id,
                    email: session.user.email || "",
                });
                ensureProfile(session.access_token);
            } else {
                setUser(null);
            }
            setAuthLoading(false);
        });

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    const signOut = async () => {
        await supabase.auth.signOut();
        setUser(null);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}

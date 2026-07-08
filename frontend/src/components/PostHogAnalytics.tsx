"use client";

import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { PostHogConfig } from "posthog-js";
import { PostHogProvider, usePostHog } from "posthog-js/react";
import { useAuth } from "@/contexts/AuthContext";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

const posthogOptions: Partial<PostHogConfig> = {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    autocapture: true,
    capture_pageview: false,
    capture_pageleave: true,
    disable_session_recording: false,
    person_profiles: "identified_only",
    session_recording: {
        maskAllInputs: true,
        blockClass: "ph-no-capture",
        maskTextClass: "ph-mask",
    },
};

function PostHogPageView() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const posthog = usePostHog();

    useEffect(() => {
        const search = searchParams.toString();
        const currentUrl = `${window.location.origin}${pathname}${search ? `?${search}` : ""}`;

        posthog.capture("$pageview", {
            $current_url: currentUrl,
        });
    }, [pathname, searchParams, posthog]);

    return null;
}

function PostHogIdentity() {
    const { user, authLoading } = useAuth();
    const posthog = usePostHog();
    const identifiedUserId = useRef<string | null>(null);

    useEffect(() => {
        if (authLoading) {
            return;
        }

        if (user) {
            if (identifiedUserId.current !== user.id) {
                posthog.identify(user.id, {
                    email: user.email,
                });
                identifiedUserId.current = user.id;
            }
            return;
        }

        if (identifiedUserId.current) {
            posthog.reset();
            identifiedUserId.current = null;
        }
    }, [authLoading, posthog, user]);

    return null;
}

function PostHogSessionReplay() {
    const posthog = usePostHog();

    useEffect(() => {
        if (!posthog.sessionRecordingStarted()) {
            posthog.startSessionRecording(true);
        }
    }, [posthog]);

    return null;
}

export function PostHogAnalytics({ children }: { children: React.ReactNode }) {
    if (!posthogKey) {
        return <>{children}</>;
    }

    return (
        <PostHogProvider apiKey={posthogKey} options={posthogOptions}>
            <Suspense fallback={null}>
                <PostHogPageView />
            </Suspense>
            <PostHogSessionReplay />
            <PostHogIdentity />
            {children}
        </PostHogProvider>
    );
}

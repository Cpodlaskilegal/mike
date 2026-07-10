"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Smooths irregular streamed chunks without ever delaying a completed or
 * replayed message. The reveal rate increases with the buffered backlog, so
 * long chunks catch up quickly instead of looking like a typewriter effect.
 */
export function useSmoothedReveal(text: string, active: boolean): string {
    const [revealedInt, setRevealedInt] = useState(text.length);
    const revealedFloat = useRef(text.length);

    useEffect(() => {
        if (!active) {
            revealedFloat.current = text.length;
            setRevealedInt(text.length);
            return;
        }

        if (revealedFloat.current > text.length) {
            revealedFloat.current = text.length;
            setRevealedInt(text.length);
        }

        let lastTick = performance.now();
        let frame = 0;
        let cancelled = false;

        const step = (now: number) => {
            if (cancelled) return;
            const elapsed = Math.max(0, (now - lastTick) / 1000);
            lastTick = now;
            const backlog = text.length - revealedFloat.current;
            if (backlog > 0) {
                const charactersPerSecond = Math.max(40, backlog / 0.4);
                const next = Math.min(
                    text.length,
                    revealedFloat.current + charactersPerSecond * elapsed,
                );
                revealedFloat.current = next;
                const nextInt = Math.floor(next);
                setRevealedInt((current) =>
                    current === nextInt ? current : nextInt,
                );
            }
            frame = window.requestAnimationFrame(step);
        };

        frame = window.requestAnimationFrame(step);
        return () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
        };
    }, [active, text.length]);

    return text.slice(0, Math.min(revealedInt, text.length));
}

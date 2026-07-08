"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    ACTIONS,
    EVENTS,
    Joyride,
    STATUS,
    type EventData,
    type Step,
} from "react-joyride";

const STORAGE_KEY = "docket:tutorial-seen";
const START_EVENT = "docket:start-tutorial";

function markSeen() {
    window.localStorage.setItem(STORAGE_KEY, "1");
}

export function DocketTutorial() {
    const router = useRouter();
    const pathname = usePathname();
    const [run, setRun] = useState(false);
    const [stepIndex, setStepIndex] = useState(0);
    const [pendingStart, setPendingStart] = useState(false);

    const steps = useMemo<Step[]>(
        () => [
            {
                target: "body",
                placement: "center",
                skipBeacon: true,
                title: "Start with the matter",
                content:
                    "Create a project for the matter you want to work on, upload the right files, then chat from that project so Docket has the right context.",
            },
            {
                target: '[data-tour="docket-projects-nav"]',
                title: "Projects",
                content:
                    "Use Projects to keep each matter separate. Confirm the project before adding client or matter files.",
            },
            {
                target: '[data-tour="docket-new-project"]',
                title: "Create a project",
                content:
                    "Create a project using the matter name or case caption. Add the matter or case number when available.",
            },
            {
                target: '[data-tour="docket-projects-page"]',
                title: "Upload matter files",
                content:
                    "After creating a project, upload the pleadings, correspondence, exhibits, contracts, discovery, and other matter files needed for the task.",
            },
            {
                target: "body",
                placement: "center",
                title: "Use a strong example",
                content:
                    "For drafting, Docket will try to find a similar filed pleading or Box toolbox form. Upload a specific example if you want that source used.",
            },
            {
                target: "body",
                placement: "center",
                title: "Open a chat",
                content:
                    "Open chat from inside the project. Ask specific questions tied to the selected matter files.",
            },
            {
                target: "body",
                placement: "center",
                title: "Choose a model",
                content:
                    "Use GPT-5.5 for most work. Use GPT-5.5 Pro for harder tasks like complex briefs, dense record review, or high-stakes drafting. Pro can take much longer.",
            },
            {
                target: "body",
                placement: "center",
                title: "Be explicit",
                content:
                    "Tell Docket the jurisdiction, forum, task, audience, and desired output. Example: draft a client-ready demand letter under Indiana law using the uploaded contract and example letter.",
            },
            {
                target: "body",
                placement: "center",
                title: "Review changes before accepting",
                content:
                    "Read every proposed edit. Accept only correct changes, reject or revise weak language, and confirm the text matches the source documents.",
            },
            {
                target: "body",
                placement: "center",
                title: "Export only after review",
                content:
                    "Before using an export, check layout, styles, numbering, captions, signature blocks, page breaks, and exhibits.",
            },
            {
                target: "body",
                placement: "center",
                title: "Verify AI-generated content",
                content:
                    "Confirm all citations and authorities, review all text, check facts and quotes, and do not send, file, or rely on raw Docket output without human review.",
            },
        ],
        [],
    );

    const startTutorial = useCallback(() => {
        setRun(false);
        setStepIndex(0);

        if (pathname !== "/projects") {
            setPendingStart(true);
            router.push("/projects");
            return;
        }

        window.setTimeout(() => setRun(true), 150);
    }, [pathname, router]);

    useEffect(() => {
        const handleStart = () => startTutorial();
        window.addEventListener(START_EVENT, handleStart);
        return () => window.removeEventListener(START_EVENT, handleStart);
    }, [startTutorial]);

    useEffect(() => {
        if (window.localStorage.getItem(STORAGE_KEY)) return;
        const timeout = window.setTimeout(startTutorial, 700);
        return () => window.clearTimeout(timeout);
    }, [startTutorial]);

    useEffect(() => {
        if (!pendingStart || pathname !== "/projects") return;
        const timeout = window.setTimeout(() => {
            setPendingStart(false);
            setRun(true);
        }, 250);
        return () => window.clearTimeout(timeout);
    }, [pathname, pendingStart]);

    function handleCallback(data: EventData) {
        const { action, index, status, type } = data;

        if (type === EVENTS.STEP_AFTER || type === EVENTS.TARGET_NOT_FOUND) {
            setStepIndex(index + (action === ACTIONS.PREV ? -1 : 1));
        }

        if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
            markSeen();
            setRun(false);
            setStepIndex(0);
        }
    }

    return (
        <Joyride
            continuous
            onEvent={handleCallback}
            options={{
                arrowColor: "#ffffff",
                backgroundColor: "#ffffff",
                buttons: ["back", "close", "primary", "skip"],
                overlayClickAction: false,
                primaryColor: "#111827",
                scrollOffset: 90,
                showProgress: true,
                skipBeacon: true,
                textColor: "#111827",
                zIndex: 1000,
            }}
            run={run}
            stepIndex={stepIndex}
            steps={steps}
            styles={{
                tooltip: {
                    borderRadius: 8,
                    fontSize: 14,
                },
                tooltipTitle: {
                    fontFamily: "serif",
                    fontSize: 20,
                    fontWeight: 500,
                },
            }}
        />
    );
}

export function startDocketTutorial() {
    window.dispatchEvent(new Event(START_EVENT));
}

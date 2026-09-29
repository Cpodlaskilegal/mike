"use client";

import {
    useState,
    useCallback,
    useEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import {
    ArrowRight,
    Check,
    File,
    FileText,
    FolderOpen,
    Library,
    Square,
    X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { AssistantDiagnosticId } from "./AssistantDiagnosticId";
import { ModelToggle } from "./ModelToggle";
import { ReasoningEffortToggle } from "./ReasoningEffortToggle";
import { ReasoningModeToggle } from "./ReasoningModeToggle";
import { useAssistantGenerationSettings } from "@/app/contexts/AssistantGenerationSettingsContext";
import {
    assistantReasoningEffortsFor,
    isOpenAiReasoningModel,
} from "@/app/lib/assistantGenerationSettings";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { DocketDocument, DocketMessage } from "../shared/types";
import {
    shouldApplyRecoveryDraft,
    shouldRestoreSubmittedDraft,
    type AssistantSubmissionResult,
} from "@/app/lib/assistantRecovery";

export interface ChatInputHandle {
    addDoc: (doc: DocketDocument) => void;
    restoreDraft: (message: DocketMessage) => void;
}

type AttachedDoc = Pick<DocketDocument, "id" | "filename" | "file_type">;

interface Props {
    onSubmit: (message: DocketMessage) => Promise<AssistantSubmissionResult> | void;
    onCancel: () => void;
    isLoading: boolean;
    recoveryDraft?: DocketMessage | null;
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    onProjectsClick?: () => void;
    projectName?: string;
    projectCmNumber?: string | null;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        recoveryDraft,
        hideAddDocButton,
        hideWorkflowButton,
        onProjectsClick,
        projectName,
        projectCmNumber,
    }: Props,
    ref,
) {
    const [value, setValue] = useState("");
    const [submissionError, setSubmissionError] = useState<string | null>(null);
    const [submissionRequestId, setSubmissionRequestId] = useState<string | null>(null);
    const [deferredRecoveryDraft, setDeferredRecoveryDraft] = useState<DocketMessage | null>(null);
    const [attachedDocs, setAttachedDocs] = useState<AttachedDoc[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const {
        state: generationSettings,
        effectiveSettings,
        hydrated,
        selectModel,
        selectEffort,
        setReasoningMode,
    } = useAssistantGenerationSettings();
    const model = generationSettings.model;
    const generationControlsDisabled = !hydrated || isLoading;
    const isGptModel = isOpenAiReasoningModel(model);
    const allowedEfforts = assistantReasoningEffortsFor(
        model,
        generationSettings.reasoningMode,
    );
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const draftEpochRef = useRef(0);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);

    const restoreDraft = useCallback((message: DocketMessage) => {
        draftEpochRef.current += 1;
        setValue(message.content);
        setSubmissionError(message.error ?? null);
        setSubmissionRequestId(message.startFailureRequestId ?? null);
        setDeferredRecoveryDraft(null);
        setAttachedDocs(
            (message.files ?? [])
                .filter((file): file is { filename: string; document_id: string } =>
                    !!file.document_id,
                )
                .map((file) => ({
                    id: file.document_id,
                    filename: file.filename,
                    file_type: null,
                })),
        );
        setSelectedWorkflow(message.workflow ?? null);
        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.style.height = "auto";
            textarea.style.height = `${textarea.scrollHeight}px`;
            textarea.focus();
        });
    }, []);

    useEffect(() => {
        if (!recoveryDraft) return;
        setSubmissionError(recoveryDraft.error ?? null);
        setSubmissionRequestId(recoveryDraft.startFailureRequestId ?? null);
        if (shouldApplyRecoveryDraft(draftEpochRef.current)) {
            restoreDraft(recoveryDraft);
        } else {
            setDeferredRecoveryDraft(recoveryDraft);
        }
    }, [recoveryDraft, restoreDraft]);

    useImperativeHandle(ref, () => ({
        addDoc: (doc: DocketDocument) => {
            draftEpochRef.current += 1;
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
        restoreDraft,
    }), [restoreDraft]);

    const handleAddDocFromProject = useCallback((doc: DocketDocument) => {
        draftEpochRef.current += 1;
        setAttachedDocs((prev) => {
            if (prev.some((d) => d.id === doc.id)) return prev;
            return [...prev, doc];
        });
    }, []);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: DocketDocument[]) => {
            draftEpochRef.current += 1;
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        draftEpochRef.current += 1;
        setValue(e.target.value);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    const handleSubmit = () => {
        const query = value.trim();
        if (!query || isLoading || !hydrated) return;
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
        }));
        setAttachedDocs([]);
        const wf = selectedWorkflow;
        setSelectedWorkflow(null);

        const submitted: DocketMessage = {
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: wf ?? undefined,
        };
        setSubmissionError(null);
        setSubmissionRequestId(null);
        setDeferredRecoveryDraft(null);
        const submissionEpoch = ++draftEpochRef.current;
        void (async () => {
            try {
                const result = await onSubmit(submitted);
                if (shouldRestoreSubmittedDraft(result, submissionEpoch, draftEpochRef.current)) {
                    restoreDraft({
                        ...(result?.kind === "preflight_failed" ? result.draft ?? submitted : submitted),
                        error: result?.kind === "preflight_failed" ? result.message : undefined,
                        startFailureRequestId: result?.kind === "preflight_failed" ? result.requestId : undefined,
                    });
                } else if (result?.kind === "preflight_failed") {
                    setSubmissionError(result.message ?? "The request could not start. Review and try again.");
                    setSubmissionRequestId(result.requestId ?? null);
                    setDeferredRecoveryDraft(result.draft ?? submitted);
                }
            } catch {
                // An unexpected rejection cannot prove that the server never
                // started work. Keep recovery explicit rather than preloading
                // a request that may already have changed external data.
            }
        })();
    };

    const handleActionClick = () => {
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <>
            <div className="w-full">
                {submissionError && (
                    <div role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                        <div>{submissionError}</div>
                        {submissionRequestId && (
                            <div className="mt-1">
                                <AssistantDiagnosticId id={submissionRequestId} kind="request" />
                            </div>
                        )}
                        {deferredRecoveryDraft && (
                            <button
                                type="button"
                                onClick={() => restoreDraft(deferredRecoveryDraft)}
                                className="mt-1 rounded border border-red-300 bg-white px-2 py-1 text-xs hover:bg-red-100"
                            >
                                Restore failed request
                            </button>
                        )}
                    </div>
                )}
                <div className="border border-gray-300 rounded-[16px] md:rounded-[20px] bg-white">
                    {/* Attached chips */}
                    {(selectedWorkflow || attachedDocs.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-blue-600 text-white border border-white/20 shadow backdrop-blur-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            draftEpochRef.current += 1;
                                            setSelectedWorkflow(null);
                                        }}
                                        className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                const ft = doc.file_type?.toLowerCase();
                                const isPdf = ft === "pdf";
                                return (
                                    <div
                                        key={doc.id}
                                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs text-white shadow border border-white/20 bg-black backdrop-blur-sm"
                                    >
                                        {isPdf ? (
                                            <FileText className="h-2.5 w-2.5 shrink-0 text-red-400" />
                                        ) : (
                                            <File className="h-2.5 w-2.5 shrink-0 text-blue-400" />
                                        )}
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                draftEpochRef.current += 1;
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                );
                                            }}
                                            className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Input */}
                    <div className="px-4 pt-4">
                        <textarea
                            data-tour="docket-chat-input"
                            ref={textareaRef}
                            rows={1}
                            placeholder="Ask a question about your documents..."
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            className="w-full resize-none text-sm overflow-hidden border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
                        />
                    </div>

                    {/* Controls */}
                    <div className="flex flex-wrap items-center justify-between gap-2 md:p-2.5 p-2">
                        <div className="flex items-center gap-1">
                            {!hideAddDocButton && (
                                <AddDocButton
                                    onSelectDoc={handleAddDocFromProject}
                                    onBrowseAll={() => setDocSelectorOpen(true)}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                />
                            )}
                            {onProjectsClick && (
                                <button
                                    type="button"
                                    onClick={onProjectsClick}
                                    aria-label="Open projects"
                                    className="flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">
                                        Projects
                                    </span>
                                </button>
                            )}
                            {!hideWorkflowButton && (
                                <button
                                    type="button"
                                    onClick={() => setWorkflowModalOpen(true)}
                                    aria-label="Open workflows"
                                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${selectedWorkflow ? "text-blue-600 hover:bg-blue-50" : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"}`}
                                >
                                    {selectedWorkflow ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Library className="h-3.5 w-3.5" />
                                    )}
                                    <span className="hidden sm:inline">
                                        Workflows
                                    </span>
                                </button>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-1">
                            <ModelToggle
                                value={model}
                                onChange={selectModel}
                                apiKeys={apiKeys}
                                disabled={generationControlsDisabled}
                            />
                            {allowedEfforts && (
                                <ReasoningEffortToggle
                                    value={effectiveSettings.reasoningEffort}
                                    efforts={allowedEfforts}
                                    onChange={selectEffort}
                                    disabled={generationControlsDisabled}
                                />
                            )}
                            {isGptModel && (
                                <ReasoningModeToggle
                                    value={generationSettings.reasoningMode}
                                    onChange={setReasoningMode}
                                    disabled={generationControlsDisabled}
                                />
                            )}
                            <button
                                type="button"
                                className="relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[10px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border border-white/30 active:enabled:scale-95 transition-all duration-150"
                                onClick={handleActionClick}
                                disabled={
                                    !hydrated ||
                                    (!isLoading && !value.trim())
                                }
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <AddDocumentsModal
                open={docSelectorOpen}
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                breadcrumb={["Assistant", "Add Documents"]}
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    draftEpochRef.current += 1;
                    setSelectedWorkflow({ id: wf.id, title: wf.title });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </>
    );
});

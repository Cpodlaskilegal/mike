import type { AssistantSidePanelTab } from "../components/assistant/AssistantSidePanel";

export function followResolvedDocumentVersion(
    tabs: readonly AssistantSidePanelTab[],
    result: { documentId: string; editId: string; status: "accepted" | "rejected"; versionId: string | null },
): AssistantSidePanelTab[] {
    return tabs.map((tab) => {
        if (tab.kind === "case" || tab.documentId !== result.documentId || tab.kind === "citation") return tab;
        if (tab.kind === "document") {
            // A selected historical version remains immutable.
            return tab.versionId !== null && !tab.followCurrentVersion ? tab : { ...tab, followCurrentVersion: true, versionId: result.versionId, versionNumber: null, warning: null };
        }
        return {
            ...tab, versionId: result.versionId, versionNumber: null, warning: null,
            edit: { ...tab.edit, version_id: result.versionId ?? tab.edit.version_id, ...(tab.edit.edit_id === result.editId ? { status: result.status } : {}) },
        };
    });
}

export type ProjectDocumentTabView = "current" | "edit" | "citation" | "historical";

/** Current/edit views follow immutable results; historical/citation views stay pinned. */
export function followResolvedProjectDocumentVersion<T extends {
    documentId: string; versionId?: string | null; view?: ProjectDocumentTabView;
    warning?: string | null; refetchKey?: number;
}>(tabs: readonly T[], result: { documentId: string; versionId: string | null }): T[] {
    return tabs.map((tab) => {
        if (tab.documentId !== result.documentId || tab.view === "citation" || tab.view === "historical") return tab;
        return { ...tab, versionId: result.versionId, warning: null, refetchKey: (tab.refetchKey ?? 0) + 1 };
    });
}

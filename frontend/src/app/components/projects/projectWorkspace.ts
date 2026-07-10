/**
 * Canonical project-workspace navigation. Existing `?tab=` links remain a
 * read-compatible fallback in ProjectPage, but all new navigation uses the
 * dedicated project routes so documents, assistant, and reviews have stable
 * URLs that can be shared or restored safely.
 */
export type ProjectWorkspaceTab = "documents" | "assistant" | "reviews";

export const PROJECT_WORKSPACE_TABS: {
    id: ProjectWorkspaceTab;
    label: string;
}[] = [
    { id: "documents", label: "Documents" },
    { id: "assistant", label: "Assistant" },
    { id: "reviews", label: "Tabular Reviews" },
];

export function projectWorkspaceHref(
    projectId: string,
    tab: ProjectWorkspaceTab,
): string {
    const base = `/projects/${encodeURIComponent(projectId)}`;
    if (tab === "assistant") return `${base}/assistant`;
    if (tab === "reviews") return `${base}/tabular-reviews`;
    return base;
}

export function projectWorkspaceTabFromLegacyQuery(
    value: string | null,
    fallback: ProjectWorkspaceTab,
): ProjectWorkspaceTab {
    return value === "assistant" || value === "reviews" ? value : fallback;
}

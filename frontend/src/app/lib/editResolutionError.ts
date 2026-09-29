export async function readEditResolutionError(response: Response): Promise<Error> {
    const fallback = "The edit save could not be confirmed. Refresh the document and retry the same decision.";
    try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") {
            return new Error(body.detail.slice(0, 600));
        }
    } catch {
        // Network/proxy responses may not contain the API's JSON error body.
    }
    return new Error(fallback);
}

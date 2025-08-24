// CLI: Analyze components and where they are used per page
// Usage: node dist/analyze_components.js <figma_url>
function getEnv(name, fallback = "") {
    return process.env[name] ?? fallback;
}
function parseFigmaUrl(figmaUrl) {
    const url = new URL(figmaUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2)
        throw new Error("Invalid Figma URL: cannot find file key in path");
    const seg = parts[0];
    if (seg !== "file" && seg !== "design")
        throw new Error("Invalid Figma URL: expected /file/<key> or /design/<key>");
    const fileKey = parts[1] ?? "";
    if (!fileKey)
        throw new Error("Invalid Figma URL: missing file key");
    const nodeId = url.searchParams.get("node-id") || url.searchParams.get("node_id") || undefined;
    return nodeId ? { fileKey, nodeId } : { fileKey };
}
async function figmaRequest(endpoint, token, init) {
    const res = await fetch(`https://api.figma.com/v1/${endpoint}`, {
        ...init,
        headers: {
            "X-Figma-Token": token,
            "Content-Type": "application/json",
            ...(init?.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Figma API error ${res.status}: ${text}`);
    }
    return (await res.json());
}
function traverse(node, visit) {
    if (!node)
        return;
    visit(node);
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const ch of kids)
        traverse(ch, visit);
}
async function main() {
    const token = getEnv("FIGMA_TOKEN");
    if (!token)
        throw new Error("FIGMA_TOKEN is required");
    const cliUrl = process.argv[2] || getEnv("FIGMA_DEFAULT_URL");
    if (!cliUrl)
        throw new Error("Provide a Figma URL or set FIGMA_DEFAULT_URL");
    const { fileKey } = parseFigmaUrl(cliUrl);
    const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
    const componentsDict = (file?.components ?? {});
    const componentById = new Map();
    for (const [nodeId, comp] of Object.entries(componentsDict)) {
        componentById.set(nodeId, comp);
    }
    const result = {
        fileName: file?.name ?? "-",
        fileKey,
        pages: [],
        allComponents: Object.entries(componentsDict).map(([nodeId, c]) => ({
            nodeId,
            key: c?.key,
            name: c?.name,
            description: c?.description ?? undefined,
            componentSetId: c?.componentSetId ?? undefined,
        })),
    };
    const pagesNodes = Array.isArray(file?.document?.children) ? file.document.children : [];
    for (const page of pagesNodes) {
        const pageName = page?.name || "(isimsiz sayfa)";
        const counts = new Map();
        traverse(page, (n) => {
            if (n?.type === "INSTANCE" && typeof n?.componentId === "string") {
                const cid = n.componentId;
                counts.set(cid, (counts.get(cid) ?? 0) + 1);
            }
        });
        const componentsUsed = Array.from(counts.entries())
            .map(([componentId, count]) => {
            const meta = componentById.get(componentId);
            return {
                componentId,
                name: meta?.name ?? "(unknown component)",
                key: meta?.key,
                count,
            };
        })
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        result.pages.push({ pageName, componentsUsed });
    }
    console.log(JSON.stringify(result, null, 2));
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
export {};
//# sourceMappingURL=analyze_components.js.map
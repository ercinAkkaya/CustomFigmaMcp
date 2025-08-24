// CLI: Inspect button-like components: color (fills), radius, text presence, size
// Usage: node dist/inspect_buttons.js <figma_url>
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
function traverse(node, visit, parent) {
    if (!node)
        return;
    visit(node, parent);
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const ch of kids)
        traverse(ch, visit, node);
}
function rgbaToHex(color, opacity = 1) {
    if (!color)
        return undefined;
    const r = Math.round((color.r ?? 0) * 255);
    const g = Math.round((color.g ?? 0) * 255);
    const b = Math.round((color.b ?? 0) * 255);
    const a = Math.round((opacity ?? 1) * 255);
    const toHex = (n) => n.toString(16).padStart(2, "0").toUpperCase();
    const rgb = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    return a < 255 ? `${rgb}${toHex(a)}` : rgb;
}
function isButtonName(name) {
    const lower = name.toLowerCase();
    return lower.includes("button") || lower.includes("btn") || lower === "defaultbutton";
}
function extractButtonInfo(node) {
    const name = node?.name || "(button)";
    const w = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
    const h = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
    const fills = Array.isArray(node?.fills) ? node.fills : [];
    const solidHexes = [];
    for (const p of fills) {
        if (p?.type === "SOLID" && p?.visible !== false && p?.color) {
            const hex = rgbaToHex(p.color, (p.opacity ?? node?.opacity ?? 1));
            if (hex)
                solidHexes.push(hex);
        }
    }
    const cornerRadius = typeof node?.cornerRadius === "number" ? node.cornerRadius : undefined;
    const rectangleCornerRadii = Array.isArray(node?.rectangleCornerRadii) ? node.rectangleCornerRadii : undefined;
    const strokes = Array.isArray(node?.strokes) ? node.strokes : [];
    const strokeWeight = typeof node?.strokeWeight === "number" ? node.strokeWeight : undefined;
    const hasStroke = strokes.some((s) => s?.visible !== false);
    const textChildren = [];
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const ch of kids) {
        if (ch?.type === "TEXT" && typeof ch?.characters === "string") {
            textChildren.push(ch.characters);
        }
    }
    return {
        name,
        size: typeof w === "number" && typeof h === "number" ? { width: w, height: h } : undefined,
        fills: solidHexes,
        cornerRadius,
        rectangleCornerRadii,
        stroke: hasStroke ? { strokeWeight } : undefined,
        text: { hasText: textChildren.length > 0, samples: textChildren.slice(0, 3) },
    };
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
    const results = [];
    const pages = Array.isArray(file?.document?.children) ? file.document.children : [];
    for (const page of pages) {
        const pageName = page?.name ?? "(page)";
        const makePath = (n) => {
            const parts = [];
            let cur = n;
            while (cur && cur !== page) {
                parts.push(cur?.name || cur?.id || "");
                cur = cur.__parent;
            }
            parts.push(pageName);
            return parts.reverse().join(" / ");
        };
        traverse(page, (n, parent) => {
            if (n && typeof n === "object")
                n.__parent = parent;
            const nm = n?.name || "";
            if (!nm)
                return;
            if (!isButtonName(nm))
                return;
            const info = extractButtonInfo(n);
            results.push({ page: pageName, path: makePath(n), info });
        });
    }
    console.log(JSON.stringify({ fileName: file?.name ?? "-", fileKey, buttons: results }, null, 2));
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
export {};
//# sourceMappingURL=inspect_buttons.js.map
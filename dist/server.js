import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Using NodeJS.ProcessEnv type from @types/node (global)
import { z } from "zod";
const SERVER_NAME = "custom-figma-mcp";
const SERVER_VERSION = "0.1.0";
// Optional default Figma URL. Paste your Figma link here if you want to run analysis without
// providing parameters from the chat/UI. Alternatively, set FIGMA_DEFAULT_URL in environment.
const DEFAULT_FIGMA_URL = process.env.FIGMA_DEFAULT_URL || "";
function getFigmaToken(env) {
    const token = env.FIGMA_TOKEN || env.FIGMA_API_TOKEN || "";
    if (!token) {
        throw new Error("Missing Figma token. Please set FIGMA_TOKEN (or FIGMA_API_TOKEN) in the environment.");
    }
    return token;
}
function rgbaToHex(color, opacity = 1) {
    const r = Math.round((color?.r ?? 0) * 255);
    const g = Math.round((color?.g ?? 0) * 255);
    const b = Math.round((color?.b ?? 0) * 255);
    const a = Math.round((opacity ?? 1) * 255);
    const toHex = (n) => n.toString(16).padStart(2, "0").toUpperCase();
    const rgb = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    const rgba = a < 255 ? `${rgb}${toHex(a)}` : rgb;
    return { rgb, rgba, alpha255: a };
}
function traverse(node, visit) {
    if (!node)
        return;
    visit(node);
    const children = Array.isArray(node?.children) ? node.children : [];
    for (const child of children)
        traverse(child, visit);
}
function extractFirstUrlCandidate(input) {
    if (!input)
        return undefined;
    const trimmed = input.trim();
    // If the whole input is a URL, try that first
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    // Otherwise, search inside the text for the first figma URL
    const match = trimmed.match(/https?:\/\/\S*figma\.com\S*/i);
    return match?.[0];
}
function parseFigmaUrl(figmaUrl) {
    // Supports:
    // https://www.figma.com/file/<fileKey>/...
    // https://www.figma.com/design/<fileKey>/...
    // Optional node id via ?node-id=<id> or ?node-id=<id>&...
    // Also supports node_id variant used by some links
    const url = new URL(figmaUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    // e.g., ["file", "<key>", ...] or ["design", "<key>", ...]
    if (parts.length < 2) {
        throw new Error("Invalid Figma URL: cannot find file key in path");
    }
    const maybeSegment = parts[0];
    if (maybeSegment !== "file" && maybeSegment !== "design") {
        throw new Error("Invalid Figma URL: expected /file/<key> or /design/<key>");
    }
    const fileKey = parts[1] ?? "";
    const nodeId = url.searchParams.get("node-id") || url.searchParams.get("node_id") || undefined;
    const result = nodeId ? { fileKey, nodeId } : { fileKey };
    return result;
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
async function main() {
    const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
        instructions: "Tools to read Figma files/nodes via Figma API. Provide FIGMA_TOKEN in env.",
        capabilities: {
            tools: {},
        },
    });
    // parse_figma_url
    mcp.tool("parse_figma_url", "Parse a Figma URL into fileKey and optional nodeId", { url: z.string() }, async ({ url }) => {
        const parsed = parseFigmaUrl(url);
        return {
            content: [
                { type: "text", text: JSON.stringify(parsed, null, 2) },
            ],
        };
    });
    // figma_get_file
    mcp.tool("figma_get_file", "Fetch Figma file JSON by fileKey", { fileKey: z.string() }, async ({ fileKey }) => {
        const token = getFigmaToken(process.env);
        const data = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    });
    // figma_get_node
    mcp.tool("figma_get_node", "Fetch specific node JSON by fileKey and nodeId", { fileKey: z.string(), nodeId: z.string() }, async ({ fileKey, nodeId }) => {
        const token = getFigmaToken(process.env);
        const data = await figmaRequest(`files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`, token);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    // figma_export_node_png_url
    mcp.tool("figma_export_node_png_url", "Get a temporary PNG export URL for a node", { fileKey: z.string(), nodeId: z.string(), scale: z.number().min(0.1).max(4).default(2) }, async ({ fileKey, nodeId, scale }) => {
        const token = getFigmaToken(process.env);
        const data = await figmaRequest(`images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${encodeURIComponent(String(scale))}`, token);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    // figma_get_from_url (smart fetch based on URL)
    mcp.tool("figma_get_from_url", "Fetch file or node JSON from a Figma URL. If the URL contains a node-id, fetches the node; otherwise, the file.", { url: z.string() }, async ({ url }) => {
        const token = getFigmaToken(process.env);
        const { fileKey, nodeId } = parseFigmaUrl(url);
        const endpoint = nodeId
            ? `files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
            : `files/${encodeURIComponent(fileKey)}`;
        const data = await figmaRequest(endpoint, token);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    // figma_analyze_report (pages + color palette summary)
    mcp.tool("figma_analyze_report", "Analyze a Figma URL: list pages and extract a color palette (top usages)", { url: z.string() }, async ({ url }) => {
        const token = getFigmaToken(process.env);
        const { fileKey } = parseFigmaUrl(url);
        const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        const document = file?.document ?? {};
        const pages = (Array.isArray(document?.children) ? document.children : [])
            .map((p) => p?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        const colorCountMap = new Map();
        traverse(document, (n) => {
            const fills = Array.isArray(n?.fills) ? n.fills : [];
            for (const paint of fills) {
                if (!paint || paint.visible === false)
                    continue;
                if (paint.type !== "SOLID" || !paint.color)
                    continue;
                const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1));
                colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
            }
        });
        const palette = Array.from(colorCountMap.entries())
            .map(([hex, count]) => ({ hex, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);
        const stylesObj = (file?.styles ?? {});
        const fillStyles = Object.values(stylesObj)
            .filter((s) => s?.styleType === "FILL")
            .map((s) => s?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        let report = "=== Figma Raporu ===\n";
        report += `Dosya adı: ${file?.name ?? "-"}\n`;
        report += `Dosya anahtarı: ${fileKey}\n\n`;
        report += "Sayfalar:\n";
        if (pages.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const p of pages)
                report += `- ${p}\n`;
        }
        report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
        if (palette.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const c of palette)
                report += `- ${c.hex} (kullanım: ${c.count})\n`;
        }
        if (fillStyles.length > 0) {
            report += "\nRenk Stilleri (FILL):\n";
            for (const n of fillStyles)
                report += `- ${n}\n`;
        }
        return { content: [{ type: "text", text: report }] };
    });
    // figma_analyze_autodetect: accepts any text, extracts first Figma URL, then analyzes
    mcp.tool("figma_analyze_autodetect", "Paste any text containing a Figma URL; this will extract the first URL and analyze it.", { input: z.string() }, async ({ input }) => {
        const maybeUrl = extractFirstUrlCandidate(input);
        if (!maybeUrl) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Input did not contain a valid Figma URL. Please include a link like https://www.figma.com/design/<key>/...",
                    },
                ],
                isError: true,
            };
        }
        const token = getFigmaToken(process.env);
        const { fileKey } = parseFigmaUrl(maybeUrl);
        const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        const document = file?.document ?? {};
        const pages = (Array.isArray(document?.children) ? document.children : [])
            .map((p) => p?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        const colorCountMap = new Map();
        traverse(document, (n) => {
            const fills = Array.isArray(n?.fills) ? n.fills : [];
            for (const paint of fills) {
                if (!paint || paint.visible === false)
                    continue;
                if (paint.type !== "SOLID" || !paint.color)
                    continue;
                const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1));
                colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
            }
        });
        const palette = Array.from(colorCountMap.entries())
            .map(([hex, count]) => ({ hex, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);
        const stylesObj = (file?.styles ?? {});
        const fillStyles = Object.values(stylesObj)
            .filter((s) => s?.styleType === "FILL")
            .map((s) => s?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        let report = "=== Figma Raporu ===\n";
        report += `Dosya adı: ${file?.name ?? "-"}\n`;
        report += `Dosya anahtarı: ${fileKey}\n\n`;
        report += "Sayfalar:\n";
        if (pages.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const p of pages)
                report += `- ${p}\n`;
        }
        report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
        if (palette.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const c of palette)
                report += `- ${c.hex} (kullanım: ${c.count})\n`;
        }
        if (fillStyles.length > 0) {
            report += "\nRenk Stilleri (FILL):\n";
            for (const n of fillStyles)
                report += `- ${n}\n`;
        }
        return { content: [{ type: "text", text: report }] };
    });
    // figma_analyze_default: analyze the URL hardcoded at the top (DEFAULT_FIGMA_URL)
    mcp.tool("figma_analyze_default", "Analyze the default Figma URL defined in server.ts (or FIGMA_DEFAULT_URL env).", {}, async () => {
        const url = DEFAULT_FIGMA_URL || "";
        if (!url) {
            return {
                content: [
                    {
                        type: "text",
                        text: "DEFAULT_FIGMA_URL is empty. Paste your Figma link into server.ts (DEFAULT_FIGMA_URL) or set FIGMA_DEFAULT_URL env.",
                    },
                ],
                isError: true,
            };
        }
        const token = getFigmaToken(process.env);
        const { fileKey } = parseFigmaUrl(url);
        const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        const document = file?.document ?? {};
        const pages = (Array.isArray(document?.children) ? document.children : [])
            .map((p) => p?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        const colorCountMap = new Map();
        traverse(document, (n) => {
            const fills = Array.isArray(n?.fills) ? n.fills : [];
            for (const paint of fills) {
                if (!paint || paint.visible === false)
                    continue;
                if (paint.type !== "SOLID" || !paint.color)
                    continue;
                const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1));
                colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
            }
        });
        const palette = Array.from(colorCountMap.entries())
            .map(([hex, count]) => ({ hex, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);
        const stylesObj = (file?.styles ?? {});
        const fillStyles = Object.values(stylesObj)
            .filter((s) => s?.styleType === "FILL")
            .map((s) => s?.name)
            .filter((n) => typeof n === "string" && n.length > 0);
        let report = "=== Figma Raporu ===\n";
        report += `Dosya adı: ${file?.name ?? "-"}\n`;
        report += `Dosya anahtarı: ${fileKey}\n\n`;
        report += "Sayfalar:\n";
        if (pages.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const p of pages)
                report += `- ${p}\n`;
        }
        report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
        if (palette.length === 0) {
            report += "- (bulunamadı)\n";
        }
        else {
            for (const c of palette)
                report += `- ${c.hex} (kullanım: ${c.count})\n`;
        }
        if (fillStyles.length > 0) {
            report += "\nRenk Stilleri (FILL):\n";
            for (const n of fillStyles)
                report += `- ${n}\n`;
        }
        return { content: [{ type: "text", text: report }] };
    });
    // figma_inventory_from_url: list components, componentSets, and styles; plus basic instance counts
    mcp.tool("figma_inventory_from_url", "Inventory components, component sets, styles and basic instance stats from a Figma URL.", { url: z.string() }, async ({ url }) => {
        const token = getFigmaToken(process.env);
        const { fileKey } = parseFigmaUrl(url);
        const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        const componentsDict = (file?.components ?? {});
        const componentSetsDict = (file?.componentSets ?? {});
        const stylesDict = (file?.styles ?? {});
        // Count INSTANCE nodes per componentId by traversing
        const instanceCountByComponentId = new Map();
        traverse(file?.document, (n) => {
            if (n?.type === "INSTANCE" && typeof n?.componentId === "string") {
                const cid = n.componentId;
                instanceCountByComponentId.set(cid, (instanceCountByComponentId.get(cid) ?? 0) + 1);
            }
        });
        const components = Object.entries(componentsDict).map(([nodeId, c]) => ({
            nodeId,
            key: c?.key,
            name: c?.name,
            description: c?.description ?? undefined,
            componentSetId: c?.componentSetId ?? undefined,
            documentationLinks: c?.documentationLinks ?? undefined,
            instanceCount: instanceCountByComponentId.get(nodeId) ?? 0,
        }));
        const componentSets = Object.entries(componentSetsDict).map(([nodeId, s]) => ({
            nodeId,
            key: s?.key,
            name: s?.name,
            description: s?.description ?? undefined,
            documentationLinks: s?.documentationLinks ?? undefined,
        }));
        const styles = Object.entries(stylesDict).map(([styleId, s]) => ({
            styleId,
            name: s?.name,
            styleType: s?.styleType,
            description: s?.description ?? undefined,
            key: s?.key ?? undefined,
        }));
        const result = {
            fileName: file?.name ?? "-",
            fileKey,
            counts: {
                components: components.length,
                componentSets: componentSets.length,
                styles: styles.length,
            },
            components,
            componentSets,
            styles,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });
    function simplifyPaints(paints, nodeOpacity) {
        const fills = [];
        const items = Array.isArray(paints) ? paints : [];
        for (const p of items) {
            if (!p || p.visible === false)
                continue;
            if (p.type === "SOLID" && p.color) {
                const { rgba } = rgbaToHex(p.color, (p.opacity ?? nodeOpacity ?? 1));
                fills.push({ type: "SOLID", hex: rgba });
            }
            else if (p.type === "IMAGE") {
                fills.push({ type: "IMAGE", opacity: (p.opacity ?? nodeOpacity ?? 1) });
            }
            else if (typeof p.type === "string") {
                fills.push({ type: p.type });
            }
        }
        return { fills };
    }
    function simplifyNode(node) {
        const type = node?.type ?? "NODE";
        const base = {
            id: node?.id,
            name: node?.name,
            type,
        };
        const w = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
        const h = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
        if (typeof w === "number" && typeof h === "number") {
            base.size = { width: w, height: h };
        }
        const opacity = (node?.opacity ?? 1);
        const { fills } = simplifyPaints(node?.fills, opacity);
        if (fills.length > 0)
            base.fills = fills;
        if (node?.strokes?.length)
            base.strokes = node.strokes;
        if (typeof node?.strokeWeight === "number")
            base.strokeWeight = node.strokeWeight;
        if (typeof node?.cornerRadius === "number")
            base.cornerRadius = node.cornerRadius;
        if (Array.isArray(node?.rectangleCornerRadii))
            base.rectangleCornerRadii = node.rectangleCornerRadii;
        if (type === "TEXT") {
            base.characters = node?.characters ?? "";
            if (node?.style)
                base.textStyle = node.style;
        }
        const kids = Array.isArray(node?.children) ? node.children : [];
        const allowedTypes = new Set(["FRAME", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "VECTOR", "TEXT", "INSTANCE", "COMPONENT"]);
        const simplifiedChildren = kids
            .filter((c) => allowedTypes.has(c?.type))
            .map((c) => simplifyNode(c));
        if (simplifiedChildren.length > 0)
            base.children = simplifiedChildren;
        return base;
    }
    // figma_export_components_json_from_url: export COMPONENT nodes as simplified JSON
    mcp.tool("figma_export_components_json_from_url", "Export all COMPONENT nodes from a Figma URL as simplified JSON trees for code generation.", { url: z.string() }, async ({ url }) => {
        const token = getFigmaToken(process.env);
        const { fileKey } = parseFigmaUrl(url);
        const file = await figmaRequest(`files/${encodeURIComponent(fileKey)}`, token);
        const components = [];
        traverse(file?.document, (n) => {
            if (n?.type === "COMPONENT") {
                components.push(simplifyNode(n));
            }
        });
        const payload = {
            fileName: file?.name ?? "-",
            fileKey,
            componentCount: components.length,
            components,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    });
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map
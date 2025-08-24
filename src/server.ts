import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Using NodeJS.ProcessEnv type from @types/node (global)
import { z } from "zod";

const SERVER_NAME = "custom-figma-mcp";
const SERVER_VERSION = "0.1.0";
// Optional default Figma URL. Paste your Figma link here if you want to run analysis without
// providing parameters from the chat/UI. Alternatively, set FIGMA_DEFAULT_URL in environment.
const DEFAULT_FIGMA_URL = process.env.FIGMA_DEFAULT_URL || "";

function getFigmaToken(env: NodeJS.ProcessEnv): string {
  const token = env.FIGMA_TOKEN || env.FIGMA_API_TOKEN || "";
  if (!token) {
    throw new Error(
      "Missing Figma token. Please set FIGMA_TOKEN (or FIGMA_API_TOKEN) in the environment."
    );
  }
  return token;
}

function rgbaToHex(color: { r: number; g: number; b: number } | undefined, opacity: number = 1): {
  rgb: string;
  rgba: string;
  alpha255: number;
} {
  const r = Math.round(((color?.r ?? 0) as number) * 255);
  const g = Math.round(((color?.g ?? 0) as number) * 255);
  const b = Math.round(((color?.b ?? 0) as number) * 255);
  const a = Math.round(((opacity ?? 1) as number) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const rgb = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  const rgba = a < 255 ? `${rgb}${toHex(a)}` : rgb;
  return { rgb, rgba, alpha255: a };
}

function traverse(node: any, visit: (n: any) => void): void {
  if (!node) return;
  visit(node);
  const children: any[] = Array.isArray(node?.children) ? (node.children as any[]) : [];
  for (const child of children) traverse(child, visit);
}

function extractFirstUrlCandidate(input: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  // If the whole input is a URL, try that first
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Otherwise, search inside the text for the first figma URL
  const match = trimmed.match(/https?:\/\/\S*figma\.com\S*/i);
  return match?.[0];
}

function parseFigmaUrl(figmaUrl: string): { fileKey: string; nodeId?: string } {
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
  const result: { fileKey: string; nodeId?: string } = nodeId ? { fileKey, nodeId } : { fileKey };
  return result;
}

async function figmaRequest<T>(
  endpoint: string,
  token: string,
  init?: RequestInit
): Promise<T> {
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
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools to read Figma files/nodes via Figma API. Provide FIGMA_TOKEN in env.",
      capabilities: {
        tools: {},
      },
    }
  );

  // parse_figma_url
  mcp.tool(
    "parse_figma_url",
    "Parse a Figma URL into fileKey and optional nodeId",
    { url: z.string() },
    async ({ url }: { url: string }) => {
      const parsed = parseFigmaUrl(url);
      return {
        content: [
          { type: "text", text: JSON.stringify(parsed, null, 2) },
        ],
      };
    }
  );

  // figma_get_file
  mcp.tool(
    "figma_get_file",
    "Fetch Figma file JSON by fileKey",
    { fileKey: z.string() },
    async ({ fileKey }: { fileKey: string }) => {
      const token = getFigmaToken(process.env);
      const data = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // figma_get_node
  mcp.tool(
    "figma_get_node",
    "Fetch specific node JSON by fileKey and nodeId",
    { fileKey: z.string(), nodeId: z.string() },
    async ({ fileKey, nodeId }: { fileKey: string; nodeId: string }) => {
      const token = getFigmaToken(process.env);
      const data = await figmaRequest<any>(
        `files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`,
        token
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // figma_export_node_png_url
  mcp.tool(
    "figma_export_node_png_url",
    "Get a temporary PNG export URL for a node",
    { fileKey: z.string(), nodeId: z.string(), scale: z.number().min(0.1).max(4).default(2) },
    async ({ fileKey, nodeId, scale }: { fileKey: string; nodeId: string; scale?: number }) => {
      const token = getFigmaToken(process.env);
      const data = await figmaRequest<any>(
        `images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${encodeURIComponent(
          String(scale)
        )}`,
        token
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // figma_get_from_url (smart fetch based on URL)
  mcp.tool(
    "figma_get_from_url",
    "Fetch file or node JSON from a Figma URL. If the URL contains a node-id, fetches the node; otherwise, the file.",
    { url: z.string() },
    async ({ url }: { url: string }) => {
      const token = getFigmaToken(process.env);
      const { fileKey, nodeId } = parseFigmaUrl(url);
      const endpoint = nodeId
        ? `files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
        : `files/${encodeURIComponent(fileKey)}`;
      const data = await figmaRequest<any>(endpoint, token);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // figma_analyze_report (pages + color palette summary)
  mcp.tool(
    "figma_analyze_report",
    "Analyze a Figma URL: list pages and extract a color palette (top usages)",
    { url: z.string() },
    async ({ url }: { url: string }) => {
      const token = getFigmaToken(process.env);
      const { fileKey } = parseFigmaUrl(url);
      const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

      const document = file?.document ?? {};
      const pages: string[] = (Array.isArray(document?.children) ? document.children : [])
        .map((p: any) => p?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      const colorCountMap = new Map<string, number>();
      traverse(document, (n: any) => {
        const fills: any[] = Array.isArray(n?.fills) ? (n.fills as any[]) : [];
        for (const paint of fills) {
          if (!paint || paint.visible === false) continue;
          if (paint.type !== "SOLID" || !paint.color) continue;
          const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1) as number);
          colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
        }
      });

      const palette = Array.from(colorCountMap.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

      const stylesObj = (file?.styles ?? {}) as Record<string, any>;
      const fillStyles = Object.values(stylesObj)
        .filter((s: any) => s?.styleType === "FILL")
        .map((s: any) => s?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      let report = "=== Figma Raporu ===\n";
      report += `Dosya adı: ${file?.name ?? "-"}\n`;
      report += `Dosya anahtarı: ${fileKey}\n\n`;
      report += "Sayfalar:\n";
      if (pages.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const p of pages) report += `- ${p}\n`;
      }

      report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
      if (palette.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const c of palette) report += `- ${c.hex} (kullanım: ${c.count})\n`;
      }

      if (fillStyles.length > 0) {
        report += "\nRenk Stilleri (FILL):\n";
        for (const n of fillStyles) report += `- ${n}\n`;
      }

      return { content: [{ type: "text", text: report }] };
    }
  );

  // figma_analyze_autodetect: accepts any text, extracts first Figma URL, then analyzes
  mcp.tool(
    "figma_analyze_autodetect",
    "Paste any text containing a Figma URL; this will extract the first URL and analyze it.",
    { input: z.string() },
    async ({ input }: { input: string }) => {
      const maybeUrl = extractFirstUrlCandidate(input);
      if (!maybeUrl) {
        return {
          content: [
            {
              type: "text",
              text:
                "Input did not contain a valid Figma URL. Please include a link like https://www.figma.com/design/<key>/...",
            },
          ],
          isError: true,
        } as any;
      }
      const token = getFigmaToken(process.env);
      const { fileKey } = parseFigmaUrl(maybeUrl);
      const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

      const document = file?.document ?? {};
      const pages: string[] = (Array.isArray(document?.children) ? document.children : [])
        .map((p: any) => p?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      const colorCountMap = new Map<string, number>();
      traverse(document, (n: any) => {
        const fills: any[] = Array.isArray(n?.fills) ? (n.fills as any[]) : [];
        for (const paint of fills) {
          if (!paint || paint.visible === false) continue;
          if (paint.type !== "SOLID" || !paint.color) continue;
          const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1) as number);
          colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
        }
      });

      const palette = Array.from(colorCountMap.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

      const stylesObj = (file?.styles ?? {}) as Record<string, any>;
      const fillStyles = Object.values(stylesObj)
        .filter((s: any) => s?.styleType === "FILL")
        .map((s: any) => s?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      let report = "=== Figma Raporu ===\n";
      report += `Dosya adı: ${file?.name ?? "-"}\n`;
      report += `Dosya anahtarı: ${fileKey}\n\n`;
      report += "Sayfalar:\n";
      if (pages.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const p of pages) report += `- ${p}\n`;
      }

      report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
      if (palette.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const c of palette) report += `- ${c.hex} (kullanım: ${c.count})\n`;
      }

      if (fillStyles.length > 0) {
        report += "\nRenk Stilleri (FILL):\n";
        for (const n of fillStyles) report += `- ${n}\n`;
      }

      return { content: [{ type: "text", text: report }] };
    }
  );

  // figma_analyze_default: analyze the URL hardcoded at the top (DEFAULT_FIGMA_URL)
  mcp.tool(
    "figma_analyze_default",
    "Analyze the default Figma URL defined in server.ts (or FIGMA_DEFAULT_URL env).",
    {},
    async () => {
      const url = DEFAULT_FIGMA_URL || "";
      if (!url) {
        return {
          content: [
            {
              type: "text",
              text:
                "DEFAULT_FIGMA_URL is empty. Paste your Figma link into server.ts (DEFAULT_FIGMA_URL) or set FIGMA_DEFAULT_URL env.",
            },
          ],
          isError: true,
        } as any;
      }
      const token = getFigmaToken(process.env);
      const { fileKey } = parseFigmaUrl(url);
      const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

      const document = file?.document ?? {};
      const pages: string[] = (Array.isArray(document?.children) ? document.children : [])
        .map((p: any) => p?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      const colorCountMap = new Map<string, number>();
      traverse(document, (n: any) => {
        const fills: any[] = Array.isArray(n?.fills) ? (n.fills as any[]) : [];
        for (const paint of fills) {
          if (!paint || paint.visible === false) continue;
          if (paint.type !== "SOLID" || !paint.color) continue;
          const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1) as number);
          colorCountMap.set(rgba, (colorCountMap.get(rgba) ?? 0) + 1);
        }
      });

      const palette = Array.from(colorCountMap.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);

      const stylesObj = (file?.styles ?? {}) as Record<string, any>;
      const fillStyles = Object.values(stylesObj)
        .filter((s: any) => s?.styleType === "FILL")
        .map((s: any) => s?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

      let report = "=== Figma Raporu ===\n";
      report += `Dosya adı: ${file?.name ?? "-"}\n`;
      report += `Dosya anahtarı: ${fileKey}\n\n`;
      report += "Sayfalar:\n";
      if (pages.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const p of pages) report += `- ${p}\n`;
      }

      report += "\nRenk Paleti (ilk 50, en çok kullanılan):\n";
      if (palette.length === 0) {
        report += "- (bulunamadı)\n";
      } else {
        for (const c of palette) report += `- ${c.hex} (kullanım: ${c.count})\n`;
      }

      if (fillStyles.length > 0) {
        report += "\nRenk Stilleri (FILL):\n";
        for (const n of fillStyles) report += `- ${n}\n`;
      }

      return { content: [{ type: "text", text: report }] };
    }
  );

  // figma_inventory_from_url: list components, componentSets, and styles; plus basic instance counts
  mcp.tool(
    "figma_inventory_from_url",
    "Inventory components, component sets, styles and basic instance stats from a Figma URL.",
    { url: z.string() },
    async ({ url }: { url: string }) => {
      const token = getFigmaToken(process.env);
      const { fileKey } = parseFigmaUrl(url);
      const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

      const componentsDict = (file?.components ?? {}) as Record<string, any>;
      const componentSetsDict = (file?.componentSets ?? {}) as Record<string, any>;
      const stylesDict = (file?.styles ?? {}) as Record<string, any>;

      // Count INSTANCE nodes per componentId by traversing
      const instanceCountByComponentId = new Map<string, number>();
      traverse(file?.document, (n: any) => {
        if (n?.type === "INSTANCE" && typeof n?.componentId === "string") {
          const cid = n.componentId as string;
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
    }
  );

  function simplifyPaints(paints: any[] | undefined, nodeOpacity: number): {
    fills: Array<{ type: string; hex?: string; opacity?: number }>;
  } {
    const fills: Array<{ type: string; hex?: string; opacity?: number }> = [];
    const items: any[] = Array.isArray(paints) ? paints : [];
    for (const p of items) {
      if (!p || p.visible === false) continue;
      if (p.type === "SOLID" && p.color) {
        const { rgba } = rgbaToHex(p.color, (p.opacity ?? nodeOpacity ?? 1) as number);
        fills.push({ type: "SOLID", hex: rgba });
      } else if (p.type === "IMAGE") {
        fills.push({ type: "IMAGE", opacity: (p.opacity ?? nodeOpacity ?? 1) as number });
      } else if (typeof p.type === "string") {
        fills.push({ type: p.type });
      }
    }
    return { fills };
  }

  function simplifyNode(node: any): any {
    const type: string = node?.type ?? "NODE";
    const base: any = {
      id: node?.id,
      name: node?.name,
      type,
    };
    const w = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
    const h = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
    if (typeof w === "number" && typeof h === "number") {
      base.size = { width: w, height: h };
    }
    const opacity: number = (node?.opacity ?? 1) as number;
    const { fills } = simplifyPaints(node?.fills, opacity);
    if (fills.length > 0) base.fills = fills;
    if (node?.strokes?.length) base.strokes = node.strokes;
    if (typeof node?.strokeWeight === "number") base.strokeWeight = node.strokeWeight;
    if (typeof node?.cornerRadius === "number") base.cornerRadius = node.cornerRadius;
    if (Array.isArray(node?.rectangleCornerRadii)) base.rectangleCornerRadii = node.rectangleCornerRadii;

    if (type === "TEXT") {
      base.characters = node?.characters ?? "";
      if (node?.style) base.textStyle = node.style;
    }
    const kids: any[] = Array.isArray(node?.children) ? node.children : [];
    const allowedTypes = new Set(["FRAME", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "VECTOR", "TEXT", "INSTANCE", "COMPONENT"]);
    const simplifiedChildren = kids
      .filter((c) => allowedTypes.has(c?.type))
      .map((c) => simplifyNode(c));
    if (simplifiedChildren.length > 0) base.children = simplifiedChildren;
    return base;
  }

  // figma_export_components_json_from_url: export COMPONENT nodes as simplified JSON
  mcp.tool(
    "figma_export_components_json_from_url",
    "Export all COMPONENT nodes from a Figma URL as simplified JSON trees for code generation.",
    { url: z.string() },
    async ({ url }: { url: string }) => {
      const token = getFigmaToken(process.env);
      const { fileKey } = parseFigmaUrl(url);
      const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

      const components: any[] = [];
      traverse(file?.document, (n: any) => {
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
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});



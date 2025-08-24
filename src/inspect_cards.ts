// CLI: Inspect card-like containers: radius, background, content summary, and view/context role
// Usage: node dist/inspect_cards.js <figma_url>

function getEnv(name: string, fallback: string = ""): string {
  return (process.env[name] as string | undefined) ?? fallback;
}

function parseFigmaUrl(figmaUrl: string): { fileKey: string; nodeId?: string } {
  const url = new URL(figmaUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Invalid Figma URL: cannot find file key in path");
  const seg = parts[0];
  if (seg !== "file" && seg !== "design") throw new Error("Invalid Figma URL: expected /file/<key> or /design/<key>");
  const fileKey: string = parts[1] ?? "";
  if (!fileKey) throw new Error("Invalid Figma URL: missing file key");
  const nodeId = url.searchParams.get("node-id") || url.searchParams.get("node_id") || undefined;
  return nodeId ? { fileKey, nodeId } : { fileKey };
}

async function figmaRequest<T>(endpoint: string, token: string, init?: RequestInit): Promise<T> {
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

function traverse(node: any, visit: (n: any, parent?: any) => void, parent?: any): void {
  if (!node) return;
  visit(node, parent);
  const kids: any[] = Array.isArray(node?.children) ? node.children : [];
  for (const ch of kids) traverse(ch, visit, node);
}

function rgbaToHex(color: { r: number; g: number; b: number } | undefined, opacity: number = 1): string | undefined {
  if (!color) return undefined;
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const a = Math.round((opacity ?? 1) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const rgb = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return a < 255 ? `${rgb}${toHex(a)}` : rgb;
}

function isIconName(name: string): boolean {
  const lower = (name || "").toLowerCase();
  return [
    "icon",
    "material-symbols",
    "mdi:",
    "majesticons:",
    "basil:",
    "fluent-color:",
    "devicon:",
    "ic:",
    "solar:",
    "lets-icons:",
    "iconamoon:",
    "fa-",
    "feather",
  ].some((h) => lower.includes(h));
}

function classifyAsCard(node: any): boolean {
  const type: string = node?.type ?? "";
  if (!["FRAME", "GROUP", "COMPONENT", "INSTANCE", "RECTANGLE"].includes(type)) return false;
  const w: number | undefined = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
  const h: number | undefined = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
  const childrenCount: number = Array.isArray(node?.children) ? node.children.length : 0;
  const fills: any[] = Array.isArray(node?.fills) ? node.fills : [];
  const hasSolidFill = fills.some((p) => p?.type === "SOLID" && p?.visible !== false);
  const strokes: any[] = Array.isArray(node?.strokes) ? node.strokes : [];
  const hasStroke = strokes.some((s) => s?.visible !== false);
  const name: string = node?.name ?? "";
  if (name.toLowerCase().includes("card")) return true;
  if (typeof w === "number" && typeof h === "number" && w >= 200 && h >= 120 && (hasSolidFill || hasStroke) && childrenCount >= 2) {
    return true;
  }
  return false;
}

function extractCardInfo(node: any) {
  const name: string = node?.name ?? "(card)";
  const w = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
  const h = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
  const fills: any[] = Array.isArray(node?.fills) ? node.fills : [];
  const fillHexes: string[] = [];
  for (const p of fills) {
    if (p?.type === "SOLID" && p?.visible !== false && p?.color) {
      const hex = rgbaToHex(p.color, (p.opacity ?? node?.opacity ?? 1) as number);
      if (hex) fillHexes.push(hex);
    }
  }
  const cornerRadius: number | undefined = typeof node?.cornerRadius === "number" ? (node.cornerRadius as number) : undefined;
  const rectangleCornerRadii: number[] | undefined = Array.isArray(node?.rectangleCornerRadii) ? (node.rectangleCornerRadii as number[]) : undefined;
  const strokes: any[] = Array.isArray(node?.strokes) ? (node.strokes as any[]) : [];
  const strokeWeight: number | undefined = typeof node?.strokeWeight === "number" ? (node.strokeWeight as number) : undefined;
  const hasStroke = strokes.some((s) => s?.visible !== false);
  let textCount = 0;
  const textSamples: string[] = [];
  let imageFillCount = 0;
  let iconCount = 0;
  let instanceCount = 0;
  const kids: any[] = Array.isArray(node?.children) ? node.children : [];
  for (const ch of kids) {
    if (ch?.type === "TEXT" && typeof ch?.characters === "string") {
      textCount += 1;
      if (textSamples.length < 3) textSamples.push(ch.characters);
    }
    if (ch?.type === "INSTANCE") {
      instanceCount += 1;
      const nm: string = ch?.name ?? "";
      if (isIconName(nm)) iconCount += 1;
    }
    const cfills: any[] = Array.isArray(ch?.fills) ? ch.fills : [];
    for (const cp of cfills) {
      if (cp?.type === "IMAGE" && cp?.visible !== false) imageFillCount += 1;
    }
  }
  return {
    name,
    size: typeof w === "number" && typeof h === "number" ? { width: w, height: h } : undefined,
    fills: fillHexes,
    cornerRadius,
    rectangleCornerRadii,
    stroke: hasStroke ? { strokeWeight } : undefined,
    content: {
      textCount,
      textSamples,
      imageFillCount,
      iconCount,
      instanceCount,
    },
  };
}

function inferRole(viewName: string, cardName: string): string {
  const v = (viewName || "").toLowerCase();
  const n = (cardName || "").toLowerCase();
  if (v.includes("home")) return "Ana sayfa kartı";
  if (v.includes("calendar") || n.includes("calendar")) return "Takvim kartı";
  if (v.includes("login") || n.includes("login")) return "Giriş/kimlik kartı";
  if (v.includes("register") || n.includes("register")) return "Kayıt kartı";
  if (v.includes("closet") || n.includes("closet")) return "Dolap/ürün kartı";
  if (v.includes("verification") || n.includes("verification") || n.includes("sms")) return "Doğrulama kartı";
  return "Genel kart";
}

async function main(): Promise<void> {
  const token = getEnv("FIGMA_TOKEN");
  if (!token) throw new Error("FIGMA_TOKEN is required");
  const cliUrl = process.argv[2] || getEnv("FIGMA_DEFAULT_URL");
  if (!cliUrl) throw new Error("Provide a Figma URL or set FIGMA_DEFAULT_URL");

  const { fileKey } = parseFigmaUrl(cliUrl);
  const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

  const pages: any[] = Array.isArray(file?.document?.children) ? file.document.children : [];
  const cards: Array<{ page: string; view: string; path: string; info: any; role: string }> = [];
  for (const page of pages) {
    const pageName: string = page?.name ?? "(page)";
    traverse(page, (n: any, parent?: any) => {
      if (n && typeof n === "object") (n as any).__parent = parent;
      if (!classifyAsCard(n)) return;
      // find nearest top-level view (FRAME under page)
      let cur: any = n;
      let topFrameName = pageName;
      while (cur && cur !== page) {
        if (cur?.type === "FRAME") topFrameName = cur?.name ?? topFrameName;
        cur = (cur as any).__parent;
      }
      const makePath = (nn: any): string => {
        const parts: string[] = [];
        let c: any = nn;
        while (c && c !== page) {
          parts.push((c?.name as string) || c?.id || "");
          c = (c as any).__parent;
        }
        parts.push(pageName);
        return parts.reverse().join(" / ");
      };
      const info = extractCardInfo(n);
      const role = inferRole(topFrameName, info.name);
      cards.push({ page: pageName, view: topFrameName, path: makePath(n), info, role });
    });
  }

  console.log(JSON.stringify({ fileName: file?.name ?? "-", fileKey, cards }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});



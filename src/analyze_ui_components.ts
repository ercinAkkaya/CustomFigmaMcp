// CLI: Analyze UI components (button, card, input, etc.) per page, excluding icons
// Usage: node dist/analyze_ui_components.js <figma_url>

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

function isIconComponentName(name: string): boolean {
  const lower = name.toLowerCase();
  const iconHints = [
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
  ];
  return iconHints.some((h) => lower.includes(h));
}

function isUiComponentName(name: string): boolean {
  const lower = name.toLowerCase();
  const uiHints = [
    "button", "btn", "primary button", "secondary button",
    "card", "list item", "list-item", "item",
    "input", "text field", "textfield", "text-field", "search",
    "checkbox", "radio", "switch", "toggle",
    "dropdown", "select", "combobox",
    "chip", "badge", "pill", "tag",
    "avatar", "image avatar",
    "tab", "tabs", "navbar", "navigation", "header", "footer",
    "modal", "dialog", "sheet", "drawer", "toast", "snackbar",
    "progress", "slider", "stepper",
  ];
  return uiHints.some((h) => lower.includes(h));
}

function hasAnySolidFill(node: any): boolean {
  const fills: any[] = Array.isArray(node?.fills) ? node.fills : [];
  return fills.some((p) => p?.type === "SOLID" && p?.visible !== false && p?.color);
}

function hasStroke(node: any): boolean {
  const strokes: any[] = Array.isArray(node?.strokes) ? node.strokes : [];
  return strokes.some((s) => s?.visible !== false);
}

function childTextCount(node: any): number {
  let count = 0;
  const kids: any[] = Array.isArray(node?.children) ? node.children : [];
  for (const ch of kids) {
    if (ch?.type === "TEXT") count += 1;
  }
  return count;
}

function childIconLikeCount(node: any): number {
  let count = 0;
  const kids: any[] = Array.isArray(node?.children) ? node.children : [];
  for (const ch of kids) {
    const n: any = ch;
    const name: string = (n?.name as string) || "";
    if (isIconComponentName(name)) count += 1;
    if (n?.type === "INSTANCE" && typeof n?.name === "string" && isIconComponentName(n.name)) count += 1;
  }
  return count;
}

function classifyStructuralUi(node: any): "button" | "input" | "card" | undefined {
  const type: string = node?.type;
  if (type !== "FRAME" && type !== "GROUP" && type !== "COMPONENT" && type !== "INSTANCE" && type !== "RECTANGLE") {
    return undefined;
  }
  const width: number | undefined = node?.absoluteBoundingBox?.width ?? node?.size?.x ?? node?.width;
  const height: number | undefined = node?.absoluteBoundingBox?.height ?? node?.size?.y ?? node?.height;
  const textCount = childTextCount(node);
  const iconCount = childIconLikeCount(node);
  const hasFill = hasAnySolidFill(node);
  const stroke = hasStroke(node);
  const name: string = (node?.name as string) || "";
  const lname = name.toLowerCase();

  // Name-based shortcuts
  if (lname.includes("button") || lname.includes("btn")) return "button";
  if (lname.includes("input") || lname.includes("textfield") || lname.includes("text field")) return "input";
  if (lname.includes("card")) return "card";

  // Structural heuristics
  // Button-like: has fill, has text, reasonable height
  if (hasFill && textCount >= 1 && typeof height === "number" && height >= 28 && height <= 64) {
    return "button";
  }
  // Input-like: stroke or light fill, textCount 0-1, larger width
  if ((stroke || hasFill) && typeof width === "number" && width >= 200 && typeof height === "number" && height >= 34 && height <= 72) {
    if (textCount <= 1 && iconCount <= 2) return "input";
  }
  // Card-like: container with fill, bigger than typical controls, may contain multiple children
  if (hasFill && typeof width === "number" && typeof height === "number") {
    if (width >= 200 && height >= 120 && (Array.isArray(node?.children) ? node.children.length : 0) >= 2) {
      return "card";
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const token = getEnv("FIGMA_TOKEN");
  if (!token) throw new Error("FIGMA_TOKEN is required");
  const cliUrl = process.argv[2] || getEnv("FIGMA_DEFAULT_URL");
  if (!cliUrl) throw new Error("Provide a Figma URL or set FIGMA_DEFAULT_URL");

  const { fileKey } = parseFigmaUrl(cliUrl);
  const file = await figmaRequest<any>(`files/${encodeURIComponent(fileKey)}`, token);

  const componentsDict = (file?.components ?? {}) as Record<string, any>;
  const componentById = new Map<string, any>();
  for (const [nodeId, comp] of Object.entries(componentsDict)) componentById.set(nodeId, comp);

  const result = {
    fileName: file?.name ?? "-",
    fileKey,
    pages: [] as Array<{
      pageName: string;
      ui: {
        buttons: Array<{ name: string; path: string }>;
        inputs: Array<{ name: string; path: string }>;
        cards: Array<{ name: string; path: string }>;
      };
    }>,
  };

  const pagesNodes: any[] = Array.isArray(file?.document?.children) ? (file.document.children as any[]) : [];
  for (const page of pagesNodes) {
    const pageName: string = (page?.name as string) || "(isimsiz sayfa)";
    const buttons: Array<{ name: string; path: string }> = [];
    const inputs: Array<{ name: string; path: string }> = [];
    const cards: Array<{ name: string; path: string }> = [];

    const makePath = (n: any): string => {
      const parts: string[] = [];
      let cur: any = n;
      while (cur && cur !== page) {
        const nm: string = (cur?.name as string) || cur?.id || "";
        if (nm) parts.push(nm);
        cur = (cur as any).__parent;
      }
      parts.push(pageName);
      return parts.reverse().join(" / ");
    };

    traverse(page, (n: any, parent?: any) => {
      if (n && typeof n === "object") (n as any).__parent = parent;
      // Prefer instances of components that are UI (name-based) and not icons
      if (n?.type === "INSTANCE" && typeof n?.componentId === "string") {
        const meta = componentById.get(n.componentId);
        const nm: string = (meta?.name as string) || (n?.name as string) || "";
        if (!nm) return;
        if (isIconComponentName(nm)) return;
        if (isUiComponentName(nm)) {
          const cat = isUiComponentName(nm) ? (nm.toLowerCase().includes("button") || nm.toLowerCase().includes("btn") ? "button" : nm.toLowerCase().includes("card") ? "card" : nm.toLowerCase().includes("input") || nm.toLowerCase().includes("text field") || nm.toLowerCase().includes("textfield") ? "input" : undefined) : undefined;
          const item = { name: nm, path: makePath(n) };
          if (cat === "button") buttons.push(item);
          else if (cat === "input") inputs.push(item);
          else if (cat === "card") cards.push(item);
          return;
        }
      }
      // Structural classification fallback
      const kind = classifyStructuralUi(n);
      if (!kind) return;
      const nm: string = (n?.name as string) || kind;
      const item = { name: nm, path: makePath(n) };
      if (kind === "button") buttons.push(item);
      else if (kind === "input") inputs.push(item);
      else if (kind === "card") cards.push(item);
    });

    result.pages.push({ pageName, ui: { buttons, inputs, cards } });
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});



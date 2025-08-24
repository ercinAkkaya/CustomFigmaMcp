// Simple CLI to analyze a Figma file: lists pages and a color palette summary
// Usage:
//   node dist/analyze.js <figma_url>
// or rely on FIGMA_DEFAULT_URL env

function getEnv(name: string, fallback: string = ""): string {
  return (process.env[name] as string | undefined) ?? fallback;
}

function parseFigmaUrl(figmaUrl: string): { fileKey: string; nodeId?: string } {
  const url = new URL(figmaUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid Figma URL: cannot find file key in path");
  }
  const maybeSegment = parts[0];
  if (maybeSegment !== "file" && maybeSegment !== "design") {
    throw new Error("Invalid Figma URL: expected /file/<key> or /design/<key>");
  }
  const fileKey = parts[1] ?? "";
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

async function main(): Promise<void> {
  const token = getEnv("FIGMA_TOKEN");
  if (!token) {
    throw new Error("FIGMA_TOKEN is required");
  }

  const cliUrl = process.argv[2];
  const envUrl = getEnv("FIGMA_DEFAULT_URL");
  const url = cliUrl || envUrl;
  if (!url) {
    throw new Error("Provide a Figma URL as an argument or set FIGMA_DEFAULT_URL");
  }

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

  console.log("=== Figma Raporu ===");
  console.log(`Dosya adı: ${file?.name ?? "-"}`);
  console.log(`Dosya anahtarı: ${fileKey}`);
  console.log("\nSayfalar:");
  if (pages.length === 0) {
    console.log("- (bulunamadı)");
  } else {
    for (const p of pages) console.log(`- ${p}`);
  }

  console.log("\nRenk Paleti (ilk 50, en çok kullanılan):");
  if (palette.length === 0) {
    console.log("- (bulunamadı)");
  } else {
    for (const c of palette) console.log(`- ${c.hex} (kullanım: ${c.count})`);
  }

  if (fillStyles.length > 0) {
    console.log("\nRenk Stilleri (FILL):");
    for (const n of fillStyles) console.log(`- ${n}`);
  }

  // Detailed per-view (top-level frames under each page)
  console.log("\n\n=== View Analizi ===");
  const pagesNodes: any[] = Array.isArray(document?.children) ? (document.children as any[]) : [];
  for (const page of pagesNodes) {
    const pageName: string = (page?.name as string) || "(isimsiz sayfa)";
    console.log(`\n[Sayfa] ${pageName}`);

    const topLevelChildren: any[] = Array.isArray(page?.children) ? (page.children as any[]) : [];
    const viewNodes = topLevelChildren.filter((n) => ["FRAME", "COMPONENT", "INSTANCE", "GROUP"].includes(n?.type));
    if (viewNodes.length === 0) {
      console.log("- Görünüm bulunamadı");
      continue;
    }
    for (const view of viewNodes) {
      const viewName: string = (view?.name as string) || "(isimsiz görünüm)";
      const type: string = (view?.type as string) || "NODE";
      const w = view?.absoluteBoundingBox?.width ?? view?.size?.x ?? view?.width ?? "?";
      const h = view?.absoluteBoundingBox?.height ?? view?.size?.y ?? view?.height ?? "?";

      // Collect stats inside this view
      let totalNodes = 0;
      let textCount = 0;
      let imageFillCount = 0;
      let vectorCount = 0;
      let componentInstanceCount = 0;
      const localColorCount = new Map<string, number>();
      traverse(view, (n: any) => {
        totalNodes += 1;
        const nodeType: string = (n?.type as string) || "";
        if (nodeType === "TEXT") textCount += 1;
        if (nodeType === "VECTOR") vectorCount += 1;
        if (nodeType === "INSTANCE") componentInstanceCount += 1;
        const fills: any[] = Array.isArray(n?.fills) ? (n.fills as any[]) : [];
        for (const paint of fills) {
          if (!paint || paint.visible === false) continue;
          if (paint.type === "IMAGE") {
            imageFillCount += 1;
            continue;
          }
          if (paint.type === "SOLID" && paint.color) {
            const { rgba } = rgbaToHex(paint.color, (paint.opacity ?? n?.opacity ?? 1) as number);
            localColorCount.set(rgba, (localColorCount.get(rgba) ?? 0) + 1);
          }
        }
      });
      const localPalette = Array.from(localColorCount.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      console.log(`- View: ${viewName} [${type}] ${w}x${h}`);
      console.log(`  • Toplam düğüm: ${totalNodes}`);
      console.log(`  • Text: ${textCount}, Vector: ${vectorCount}, Instance: ${componentInstanceCount}, Image fills: ${imageFillCount}`);
      if (localPalette.length > 0) {
        console.log(`  • Renkler (ilk 8): ${localPalette.map((c) => c.hex).join(", ")}`);
      }
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});



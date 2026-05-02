import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function figmaColorToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  if (color.a < 1) {
    const a = Math.round(color.a * 255);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a.toString(16).padStart(2, "0")}`;
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function extractTokensFromNode(node: any): any {
  const tokens: any = {
    name: node.name,
    type: node.type,
    width: node.absoluteBoundingBox?.width ?? node.size?.x,
    height: node.absoluteBoundingBox?.height ?? node.size?.y,
  };

  if (node.cornerRadius !== undefined) {
    tokens.borderRadius = node.cornerRadius;
  }
  if (node.rectangleCornerRadii) {
    tokens.borderRadii = node.rectangleCornerRadii;
  }

  if (node.fills && node.fills.length > 0) {
    const solidFill = node.fills.find((f: any) => f.type === "SOLID" && f.visible !== false);
    if (solidFill) {
      tokens.bgColor = figmaColorToHex(solidFill.color);
      tokens.bgOpacity = solidFill.opacity ?? 1;
    }
    const gradientFill = node.fills.find((f: any) => f.type?.includes("GRADIENT") && f.visible !== false);
    if (gradientFill) {
      tokens.gradient = {
        type: gradientFill.type,
        stops: gradientFill.gradientStops?.map((s: any) => ({
          color: figmaColorToHex(s.color),
          position: s.position,
        })),
      };
    }
  }

  if (node.strokes && node.strokes.length > 0) {
    const solidStroke = node.strokes.find((s: any) => s.type === "SOLID" && s.visible !== false);
    if (solidStroke) {
      tokens.borderColor = figmaColorToHex(solidStroke.color);
      tokens.borderWidth = node.strokeWeight ?? 1;
    }
  }

  if (node.effects && node.effects.length > 0) {
    tokens.effects = node.effects
      .filter((e: any) => e.visible !== false)
      .map((e: any) => ({
        type: e.type,
        color: e.color ? figmaColorToHex(e.color) : undefined,
        offset: e.offset,
        radius: e.radius,
        spread: e.spread,
      }));
  }

  if (node.opacity !== undefined && node.opacity !== 1) {
    tokens.opacity = node.opacity;
  }

  if (node.paddingLeft !== undefined) {
    tokens.padding = {
      top: node.paddingTop ?? 0,
      right: node.paddingRight ?? 0,
      bottom: node.paddingBottom ?? 0,
      left: node.paddingLeft ?? 0,
    };
  }

  if (node.itemSpacing !== undefined) {
    tokens.gap = node.itemSpacing;
  }

  if (node.layoutMode) {
    tokens.layoutMode = node.layoutMode;
    tokens.layoutAlign = node.primaryAxisAlignItems;
    tokens.counterAxisAlign = node.counterAxisAlignItems;
  }

  if (node.style) {
    tokens.textStyle = {
      fontFamily: node.style.fontFamily,
      fontSize: node.style.fontSize,
      fontWeight: node.style.fontWeight,
      lineHeight: node.style.lineHeightPx,
      letterSpacing: node.style.letterSpacing,
    };
  }

  return tokens;
}

function extractAllComponents(node: any, path: string = ""): any[] {
  const results: any[] = [];
  const currentPath = path ? `${path}/${node.name}` : node.name;

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE" || node.type === "FRAME") {
    const tokens = extractTokensFromNode(node);
    tokens.path = currentPath;
    tokens.nodeId = node.id;

    if (node.children && node.children.length > 0) {
      tokens.children = node.children.map((child: any) => extractTokensFromNode(child));
    }

    results.push(tokens);
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...extractAllComponents(child, currentPath));
    }
  }

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { figmaToken, fileId, nodeIds, action } = await req.json();

    if (!figmaToken || !fileId) {
      return new Response(
        JSON.stringify({ error: "figmaToken and fileId are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const figmaHeaders = {
      "X-Figma-Token": figmaToken,
    };

    if (action === "inspect") {
      const nodeParam = nodeIds ? `?ids=${nodeIds}&depth=5` : "?depth=3";
      const url = nodeIds
        ? `https://api.figma.com/v1/files/${fileId}/nodes${nodeParam}`
        : `https://api.figma.com/v1/files/${fileId}${nodeParam}`;

      const resp = await fetch(url, { headers: figmaHeaders });
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(
          JSON.stringify({ error: `Figma API error: ${resp.status}`, details: errText }),
          { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const figmaData = await resp.json();
      let components: any[] = [];

      if (nodeIds && figmaData.nodes) {
        for (const [_id, nodeData] of Object.entries(figmaData.nodes as Record<string, any>)) {
          if (nodeData.document) {
            components.push(...extractAllComponents(nodeData.document));
          }
        }
      } else if (figmaData.document) {
        components = extractAllComponents(figmaData.document);
      }

      return new Response(
        JSON.stringify({ components, raw: figmaData }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "sync") {
      const nodeParam = nodeIds ? `?ids=${nodeIds}&depth=5` : "?depth=4";
      const url = nodeIds
        ? `https://api.figma.com/v1/files/${fileId}/nodes${nodeParam}`
        : `https://api.figma.com/v1/files/${fileId}${nodeParam}`;

      const resp = await fetch(url, { headers: figmaHeaders });
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(
          JSON.stringify({ error: `Figma API error: ${resp.status}`, details: errText }),
          { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const figmaData = await resp.json();
      let components: any[] = [];

      if (nodeIds && figmaData.nodes) {
        for (const [_id, nodeData] of Object.entries(figmaData.nodes as Record<string, any>)) {
          if (nodeData.document) {
            components.push(...extractAllComponents(nodeData.document));
          }
        }
      } else if (figmaData.document) {
        components = extractAllComponents(figmaData.document);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const tokensToSave = components.map((comp) => ({
        component_name: comp.name,
        component_path: comp.path,
        figma_node_id: comp.nodeId,
        figma_file_id: fileId,
        tokens: comp,
        synced_at: new Date().toISOString(),
      }));

      for (const token of tokensToSave) {
        const { error } = await supabase
          .from("figma_design_tokens")
          .upsert(token, { onConflict: "figma_file_id,figma_node_id" });
        if (error) {
          console.error("DB upsert error:", error);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          synced: tokensToSave.length,
          components: components.map((c) => ({ name: c.name, path: c.path, nodeId: c.nodeId })),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'inspect' or 'sync'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal error", details: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

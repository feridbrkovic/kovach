/**
 * Image generation for the agent (MASTER_PLAN › Image & video generation).
 *
 * The chat model can't make images, so a separate media worker does, behind the
 * `MediaProvider` interface. The desktop app supplies a provider backed by a
 * local Python process (mflux + FLUX.2 klein); tests use a fake one. The tool
 * saves the image into the project and hands it back so the model can look at
 * the result.
 */
import { z } from "zod";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

export interface GenerateImageRequest {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed?: number;
}

export interface MediaProvider {
  /** Generate a PNG and return its bytes. May take a while; honour `signal`. */
  generateImage(req: GenerateImageRequest, signal?: AbortSignal): Promise<Buffer>;
}

const SIZES = [512, 768, 1024] as const;
const nearestSize = (n: number) => SIZES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));

/** The generate_image tool, bound to a provider. Not in the default TOOLS; added only when the media module is on. */
export function imageTools(provider: MediaProvider): AgentTool[] {
  const generate: AgentTool = {
    name: "generate_image",
    description:
      "Generate an image from a text prompt and save it in the project. Good for icons, mockups and illustrations. Returns the saved path and shows you the result.",
    schema: z.object({
      prompt: z.string().min(1),
      path: z.string().describe("Where to save it in the project, ending in .png, e.g. 'assets/hero.png'"),
      width: z.number().int().min(256).max(1536).default(1024),
      height: z.number().int().min(256).max(1536).default(1024),
      steps: z.number().int().min(1).max(50).default(4),
      seed: z.number().int().optional(),
    }),
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const a = args as { prompt: string; path: string; width: number; height: number; steps: number; seed?: number };
      if (!a.path.toLowerCase().endsWith(".png")) return { ok: false, content: "The path must end in .png." };
      const abs = ctx.workspace.resolve(a.path); // also refuses paths outside the project / secret-like
      const width = nearestSize(a.width);
      const height = nearestSize(a.height);
      if (!(await ctx.approve({ kind: "media", command: `generate image → ${a.path}`, cwd: ctx.workspace.root }))) {
        return { ok: false, content: "The user declined the image generation." };
      }
      let png: Buffer;
      try {
        png = await provider.generateImage({ prompt: a.prompt, width, height, steps: a.steps, ...(a.seed !== undefined ? { seed: a.seed } : {}) }, ctx.signal);
      } catch (err) {
        return { ok: false, content: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, png);
      return {
        ok: true,
        edited: true,
        content: `Saved ${a.path} (${width}×${height}).`,
        files: [abs],
        images: [{ type: "image", mediaType: "image/png", data: png.toString("base64") }],
      };
    },
  } as AgentTool;
  return [generate];
}

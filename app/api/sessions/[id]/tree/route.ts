import { NextResponse } from "next/server";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { buildConversationTree } from "@/lib/conversation-tree";
import { loadSessionFile } from "@/lib/omp/session-files";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const headers = { "Cache-Control": "no-store" };
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) {
      resolved.response.headers.set("Cache-Control", "no-store");
      return resolved.response;
    }
    /** Keep ancestry and original prompt text only; never resolve image blobs
     * or retain assistant/tool payloads while loading the bounded JSONL file. */
    const loaded = loadSessionFile(resolved.filePath, {
      resolveBlobs: false,
      projectEntry(entry) {
        const base = {
          type: entry.type,
          id: entry.id,
          parentId: entry.parentId,
          timestamp: entry.timestamp,
        };
        if (entry.type !== "message" || entry.message?.role !== "user") {
          return base as SessionEntry;
        }
        const content = entry.message.content;
        return {
          ...base,
          type: "message",
          message: {
            role: "user",
            content: typeof content === "string" ? content : content
              .filter((block) => block?.type === "text" || block?.type === "image")
              .map((block) => block.type === "text"
                ? { type: "text", text: block.text }
                : { type: "image" }),
          },
        } as SessionEntry;
      },
    });
    if (loaded.error === "too_large") {
      return NextResponse.json(
        { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
        { status: 413, headers },
      );
    }
    if (!loaded.header) {
      return NextResponse.json(
        { error: "Session file is missing or malformed", code: "session_file_malformed" },
        { status: 404, headers },
      );
    }
    const leafId = new URL(req.url).searchParams.get("leafId") ?? undefined;
    return NextResponse.json(buildConversationTree(loaded.entries, leafId), { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}

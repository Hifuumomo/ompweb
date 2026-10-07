import { NextResponse } from "next/server";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { invalidateSessionCaches } from "@/lib/session-reader";
import {
  deleteSessionPromptSubtree,
  readSessionConversationTree,
  SessionTreeDeletionError,
} from "@/lib/session-tree-deletion";

const headers = { "Cache-Control": "no-store" };

/** Keep mutation failures stable and all tree responses out of browser caches. */
function treeErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionTreeDeletionError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413, headers });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400, headers });
  }
  const response = apiErrorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) {
      resolved.response.headers.set("Cache-Control", "no-store");
      return resolved.response;
    }
    const leafId = new URL(req.url).searchParams.get("leafId") ?? undefined;
    const tree = await readSessionConversationTree(resolved.filePath, leafId);
    return NextResponse.json(tree, { headers });
  } catch (error) {
    if (error instanceof SessionTreeDeletionError && error.code === "session_tree_invalid") {
      return NextResponse.json(
        { error: "Session file is missing or malformed", code: "session_file_malformed" },
        { status: 404, headers },
      );
    }
    return treeErrorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) {
      resolved.response.headers.set("Cache-Control", "no-store");
      return resolved.response;
    }
    const body = await parseJsonWithinLimit<unknown>(req, 64 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !("promptId" in body) || typeof body.promptId !== "string"
      || !("expectedRevision" in body) || typeof body.expectedRevision !== "string") {
      return NextResponse.json(
        { error: "promptId and expectedRevision are required", code: "session_tree_invalid_target" },
        { status: 400, headers },
      );
    }
    const result = await deleteSessionPromptSubtree(resolved.filePath, body.promptId, body.expectedRevision);
    invalidateSessionCaches(resolved.filePath);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

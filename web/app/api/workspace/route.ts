import { NextResponse } from "next/server";
import { lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { isGateError, requireOwner } from "../../../lib/desktop-gate";
import { apiError, errorCode, rateLimited, readJson } from "../../../lib/api-guard";
import { isGrantableRootPath } from "../../../../shared/shell-store.ts";
import {
  readWorkspaceStore,
  removeProject,
  upsertProject,
} from "../../../../shared/workspace-store.ts";

/**
 * Project recents for the composer's project chip. The grants themselves live
 * beside the bot in the shell store; this endpoint only maintains the list of
 * folders the owner has worked in, so the menu can offer them again.
 */
export async function GET(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  try {
    return NextResponse.json({ ok: true, projects: readWorkspaceStore().projects });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errorCode(err, "workspace_unavailable") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const gate = await requireOwner(request);
  if (isGateError(gate)) return gate.error;
  const csrf = request.headers.get("x-ub-csrf");
  if (!csrf || csrf !== gate.session.csrf) {
    return NextResponse.json({ ok: false, error: "csrf" }, { status: 403 });
  }
  if (rateLimited(`workspace:${gate.session.callerId}`, 60)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }
  try {
    const body = await readJson(request) as {
      action?: "addProject" | "removeProject";
      path?: string;
      id?: string;
    };
    if (body.action === "addProject") {
      const path = body.path ?? "";
      try {
        if (!isGrantableRootPath(path)) {
          return NextResponse.json({ ok: false, error: "workspace_path_forbidden" }, { status: 400 });
        }
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          return NextResponse.json({ ok: false, error: "workspace_not_directory" }, { status: 400 });
        }
        if (realpathSync(path) !== path) {
          return NextResponse.json({ ok: false, error: "workspace_path_symlink" }, { status: 400 });
        }
      } catch {
        // Only the filesystem checks above are a missing path; the store's own
        // refusal below says something different and should say so.
        return NextResponse.json({ ok: false, error: "workspace_path_missing" }, { status: 400 });
      }
      try {
        upsertProject({ path: realpathSync(path), name: basename(path) });
      } catch (err) {
        return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
      }
    } else if (body.action === "removeProject") {
      if (!body.id) {
        return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      removeProject(body.id);
    } else {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, projects: readWorkspaceStore().projects });
  } catch (err) {
    const guarded = apiError(err);
    if (guarded) return guarded;
    return NextResponse.json({ ok: false, error: errorCode(err) }, { status: 400 });
  }
}

import type { UsefulTool } from "../lib/tool.ts";
import ask from "./ask.ts";
import apps from "./apps.ts";
import bash from "./bash.ts";
import connectServer from "./connect_server.ts";
import findTools from "./find_tools.ts";
import generateImage from "./generate_image.ts";
import installCli from "./install_cli.ts";
import listDir from "./list_dir.ts";
import loadSkill from "./load_skill.ts";
import memory from "./memory.ts";
import readFile from "./read_file.ts";
import routine from "./routine.ts";
import todo from "./todo.ts";
import webFetch from "./web_fetch.ts";
import webSearch from "./web_search.ts";
import writeFile from "./write_file.ts";

/**
 * The 16 declared tools of SPEC 5.8, in a fixed order (the order is part of the
 * cached prompt). The engine host (agent/engine/pi-host.ts) turns each entry
 * into a Pi tool with `toPiTool`. Picked MCP tools are not here: they register
 * per chat at pick time (agent/tools/picked.ts).
 */
export function allTools(): UsefulTool[] {
  return [
    bash,
    readFile,
    writeFile,
    listDir,
    webSearch,
    webFetch,
    memory,
    routine,
    apps,
    connectServer,
    findTools,
    generateImage,
    installCli,
    todo,
    ask,
    loadSkill,
  ] as UsefulTool[];
}

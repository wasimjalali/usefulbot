/**
 * The short line the working row shows while a tool runs. Sentence case, no
 * trailing period, as the fixtures pin (`Searching the web`, `Running a command`).
 */
const LABELS: Record<string, string> = {
  bash: "Running a command",
  read_file: "Reading a file",
  write_file: "Writing a file",
  list_dir: "Looking in a folder",
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  memory: "Using your notes",
  routine: "Working on a routine",
  apps: "Using an app",
  connect_server: "Connecting a server",
  find_tools: "Finding tools",
  generate_image: "Drawing an image",
  install_cli: "Installing a tool",
  todo: "Planning the steps",
  ask: "Asking you",
  load_skill: "Reading a skill",
};

/** `<connectionId>__<tool>` picked MCP tools show the connection's name. */
export function toolDetail(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  const split = name.indexOf("__");
  const connection = split > 0 ? name.slice(0, split) : name;
  const words = connection.replace(/[-_]+/g, " ").trim();
  return words === "" ? "Working" : words.charAt(0).toUpperCase() + words.slice(1);
}

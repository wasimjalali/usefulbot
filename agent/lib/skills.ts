import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The packaged skills under agent/skills/<name>/SKILL.md. A skill is a short
 * how-to the bot loads on demand: the system prompt lists each one's name and
 * one-line description (`listSkills`), and `load_skill` returns the text
 * (`readSkill`). Pi's own skill discovery is off (SPEC D4), so this is the
 * only way a skill reaches the model.
 */

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SkillSummary = { name: string; description: string };

/**
 * Front matter is two quoted-or-plain single-line values, `name` and
 * `description`. A description holding ": " must be quoted: an unquoted one is
 * refused here the way a YAML parser would refuse it, so a typo fails a test
 * instead of reaching the prompt.
 */
export function parseSkill(markdown: string): SkillSummary & { body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("skill_front_matter_missing");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`skill_front_matter_line: ${line}`);
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) throw new Error(`skill_front_matter_quote: ${kv[1]}`);
      value = JSON.parse(value) as string;
    } else if (value.includes(": ") || value.includes(" #")) {
      throw new Error(`skill_front_matter_unquoted: ${kv[1]}`);
    }
    fields.set(kv[1], value);
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!NAME.test(name)) throw new Error("skill_name_invalid");
  if (!description.trim()) throw new Error("skill_description_missing");
  return { name, description, body: match[2].replace(/^\n+/, "") };
}

function skillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every packaged skill, for the system prompt. A skill that fails to parse throws: that is a packaging bug. */
export function listSkills(): SkillSummary[] {
  return skillDirs().map((dir) => {
    const { name, description } = parseSkill(readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8"));
    if (name !== dir) throw new Error(`skill_name_mismatch: ${dir}`);
    return { name, description };
  });
}

/** The skill's text, or null when no skill has that name. */
export function readSkill(name: string): string | null {
  if (!NAME.test(name) || !skillDirs().includes(name)) return null;
  return parseSkill(readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8")).body;
}

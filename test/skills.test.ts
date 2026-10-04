import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// eve refuses to start when one skill's frontmatter isn't valid, which takes
// every bot down with it (seen live: an unquoted description holding ": "
// broke discovery). Every packaged skill goes through eve's own lowering, the
// same function its discovery runs, so the test agrees with eve by construction.

const SKILLS = "agent/skills";
const { lowerSkillMarkdown } = (await import(
  pathToFileURL(resolve("node_modules/eve/dist/src/internal/helpers/markdown.js")).href
)) as { lowerSkillMarkdown: (markdown: string) => { description: string } };

test("eve refuses a description holding an unquoted colon, and takes the quoted one", () => {
  assert.throws(() => lowerSkillMarkdown("---\ndescription: Use it for this: and that.\n---\n# x\n"));
  assert.throws(() => lowerSkillMarkdown("# no frontmatter\n"));
  assert.throws(() => lowerSkillMarkdown("---\nlicense: MIT\n---\n# x\n"));
  assert.equal(lowerSkillMarkdown("---\ndescription: \"Use it for this: and that.\"\n---\n# x\n").description, "Use it for this: and that.");
});

test("every packaged skill lowers in eve with a description", () => {
  const names = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(names.length >= 2, "expected the packaged skills");
  for (const name of names) {
    const path = join(SKILLS, name, "SKILL.md");
    assert.ok(existsSync(path), `${name} has no SKILL.md`);
    const skill = lowerSkillMarkdown(readFileSync(path, "utf8"));
    assert.ok(skill.description.trim().length > 0, `${name} description is empty`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSkills, parseSkill, readSkill } from "../agent/lib/skills.ts";
import loadSkill from "../agent/tools/load_skill.ts";
import { fakeCtx } from "./tools/ctx.ts";

// A skill whose front matter doesn't parse would put a broken line in every
// system prompt. The parser refuses what a YAML parser would (an unquoted
// description holding ": " broke discovery once), so a typo fails here.

const SKILLS = "agent/skills";

test("a description holding an unquoted colon is refused, and the quoted one is taken", () => {
  assert.throws(() => parseSkill("---\nname: x\ndescription: Use it for this: and that.\n---\n# x\n"), /unquoted/);
  assert.throws(() => parseSkill("# no front matter\n"), /front_matter_missing/);
  assert.throws(() => parseSkill("---\nname: x\n---\n# x\n"), /description_missing/);
  assert.throws(() => parseSkill("---\ndescription: \"only a description\"\n---\n# x\n"), /name_invalid/);
  assert.throws(() => parseSkill("---\nname: Bad Name\ndescription: \"d\"\n---\n# x\n"), /name_invalid/);
  assert.throws(() => parseSkill("---\nname: x\ndescription: \"unterminated\n---\n# x\n"), /quote/);
  const ok = parseSkill("---\nname: x\ndescription: \"Use it for this: and that.\"\n---\n\n# x\nbody\n");
  assert.equal(ok.description, "Use it for this: and that.");
  assert.equal(ok.name, "x");
  assert.equal(ok.body, "# x\nbody\n");
});

test("every packaged skill parses, its name is its folder, and the list covers them all", () => {
  const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.ok(dirs.length >= 2, "expected the packaged skills");
  for (const dir of dirs) {
    const path = join(SKILLS, dir, "SKILL.md");
    assert.ok(existsSync(path), `${dir} has no SKILL.md`);
    const skill = parseSkill(readFileSync(path, "utf8"));
    assert.equal(skill.name, dir);
    assert.ok(skill.description.trim().length > 0, `${dir} description is empty`);
    assert.ok(skill.body.trim().length > 0, `${dir} has no body`);
  }
  assert.deepEqual(listSkills().map((skill) => skill.name), dirs);
});

test("readSkill answers only for a real skill name, never a path", () => {
  assert.match(readSkill("about-useful-bot") ?? "", /Answer from these facts only/);
  for (const bad of ["", "nope", "../instructions", "about-useful-bot/../connect-apps", "ABOUT", "about-useful-bot\0"]) {
    assert.equal(readSkill(bad), null, JSON.stringify(bad));
  }
});

test("load_skill returns the skill text, and names the choices when the name is wrong", async () => {
  const ctx = fakeCtx();
  const found = await loadSkill.execute({ name: "connect-apps" }, ctx);
  assert.match(String(found), /# Connect apps/);
  assert.doesNotMatch(String(found), /^---/);
  const missing = await loadSkill.execute({ name: "no-such-skill" }, ctx) as { status: string; skills: string[] };
  assert.equal(missing.status, "not_found");
  assert.deepEqual(missing.skills, listSkills().map((skill) => skill.name));
});

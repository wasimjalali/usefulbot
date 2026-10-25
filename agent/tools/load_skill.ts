import { defineTool } from "../lib/tool.ts";
import { z } from "zod";
import { listSkills, readSkill } from "../lib/skills.ts";

export default defineTool({
  name: "load_skill",
  description: "Load a skill by name: a short how-to for one kind of job. The system prompt lists the skills.",
  inputSchema: z.object({
    name: z.string().min(1).max(64),
  }),
  execute(input) {
    const body = readSkill(input.name.trim());
    if (body === null) {
      return { status: "not_found", error: `no skill named ${input.name}`, skills: listSkills().map((skill) => skill.name) };
    }
    return body;
  },
});

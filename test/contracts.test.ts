import assert from "node:assert/strict";
import test from "node:test";
import { POLICY_NODE_MAJOR } from "../shared/policy.ts";

test("runtime is Node 24", () => {
  assert.equal(Number(process.versions.node.split(".")[0]), POLICY_NODE_MAJOR);
});

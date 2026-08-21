import { strict as assert } from "node:assert";
import { findGitWorkspace, uniqueWorkspacePaths } from "../src/lib/pullRequests";

assert.deepEqual(
  uniqueWorkspacePaths(["D:\\Repo", "d:/repo/", "", "D:\\Other"]),
  ["D:\\Repo", "D:\\Other"],
);

const visited: string[] = [];
const resolved = await findGitWorkspace(
  "D:\\Notes",
  ["D:\\Notes", "D:\\Repo"],
  async (workspace) => {
    visited.push(workspace);
    return workspace === "D:\\Repo" ? "D:\\Repo" : null;
  },
);
assert.deepEqual(visited, ["D:\\Notes", "D:\\Repo"]);
assert.deepEqual(resolved, { workspace: "D:\\Repo", repositoryRoot: "D:\\Repo" });

const explicitInvalid = await findGitWorkspace(
  "D:\\Notes",
  ["D:\\Notes", "D:\\Repo"],
  async (workspace) => workspace === "D:\\Repo" ? "D:\\Repo" : null,
  false,
);
assert.equal(explicitInvalid, null);

console.log("pull-requests: all assertions passed");

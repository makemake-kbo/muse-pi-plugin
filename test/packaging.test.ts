import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

test("Pi loads a standalone package with only host-supplied dependencies", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-package-"));
  try {
    // Outside the source tree: no accidental resolution through our dev node_modules.
    await cp(new URL("../src/", import.meta.url), join(directory, "extension"), { recursive: true });
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
    const { stdout, stderr } = await exec(process.execPath, [cli,
      "--offline", "--no-extensions", "--no-context-files",
      "-e", join(directory, "extension", "index.ts"), "--list-models", "muse",
    ], {
      cwd: directory,
      env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"),
        MUSE_API_KEY: "local-package-placeholder", MUSE_AUTH_FILE: join(directory, "absent.json"),
      },
      timeout: 25_000,
    });
    assert.doesNotMatch(stderr, /Failed to load extension/);
    assert.match(stdout, /muse\s+muse-spark-1\.3-contributor/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

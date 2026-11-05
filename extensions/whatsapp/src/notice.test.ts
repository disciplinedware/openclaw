import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("NOTICE", () => {
  it("names the OpenClaw release and fork branch the package builds on", () => {
    // The package version is the upstream release plus the fork's correction suffix `-N`.
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const release = version.replace(/-\d+$/, "");
    const notice = read("NOTICE");

    expect(notice).toContain(`Upstream tag:     v${release}\n`);
    expect(notice).toContain(`git diff v${release} whatsapp-for-business-${release}`);
  });
});

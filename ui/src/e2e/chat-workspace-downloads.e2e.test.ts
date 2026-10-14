import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("downloads original file bytes from the list and preview without opening another page", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const text = Buffer.from("# Release report\r\n\r\nAll systems ready. 🦞\r\n");
    const binary = Buffer.alloc(300 * 1024, 0xa5);
    const requests: string[] = [];
    let failNextDownload = false;
    await page.route("**/api/artifacts/download/e2e/*", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      expect(route.request().headers().authorization).toBeUndefined();
      requests.push(name);
      if (failNextDownload) {
        failNextDownload = false;
        await route.fulfill({ status: 404, body: "Not found" });
        return;
      }
      await route.fulfill({
        contentType: name === "archive" ? "application/zip" : "text/markdown",
        headers: { "content-disposition": 'attachment; filename="download"' },
        body: name === "archive" ? binary : text,
      });
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.download": {
          filename: "release report.md",
          mimeType: "text/markdown",
          url: "/api/artifacts/download/e2e/report",
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "sessions.files.list": {
          sessionKey: "agent:main:main",
          root: "/workspace/project",
          files: [],
          browser: {
            path: "",
            entries: [
              { kind: "directory", name: "reports", path: "reports" },
              {
                kind: "file",
                name: "release report.md",
                path: "release report.md",
                size: text.length,
              },
              { kind: "file", name: "archive.zip", path: "archive.zip", size: binary.length },
            ],
          },
        },
        "sessions.files.get": {
          sessionKey: "agent:main:main",
          root: "/workspace/project",
          file: {
            path: "/workspace/project/release report.md",
            workspacePath: "release report.md",
            name: "release report.md",
            kind: "read",
            missing: false,
            content: text.toString(),
            contentEncoding: "utf8",
            previewKind: "text",
            mimeType: "text/markdown",
          },
        },
      },
    });
    const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifacts = artifactParent
      ? createControlUiE2eArtifactDir("file-downloads", artifactParent)
      : undefined;
    const capture = async (surface: Locator, name: string) => {
      if (!artifacts) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
        elements: [surface],
        animations: "disabled",
      });
      await writeFile(path.join(artifacts, name), frame.elements[0]!.png);
    };
    const download = async (button: Locator, name: string, bytes: Buffer) => {
      const event = page.waitForEvent("download");
      await button.click();
      const file = await event;
      expect(file.suggestedFilename()).toBe(name);
      const savedPath = await file.path();
      expect(savedPath).toBeTruthy();
      expect(await readFile(savedPath!)).toEqual(bytes);
      expect(await file.failure()).toBeNull();
    };
    try {
      await page.goto(suite.server.baseUrl + "chat");
      const originalUrl = page.url();
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".chat-workspace-rail");
      const row = rail.getByRole("listitem").filter({ hasText: "release report.md" });
      await row.getByRole("button", { name: "release report.md", exact: true }).click();
      const preview = page.locator(".sidebar-file-view");
      await preview.locator(".cm-editor").waitFor();
      await capture(preview, "preview.png");
      await preview.getByRole("button", { name: "Show in Files", exact: true }).click();
      await row.hover();
      await capture(rail, "list.png");
      expect(
        await rail
          .getByRole("listitem")
          .filter({ hasText: "reports" })
          .getByRole("button", { name: "Download file" })
          .count(),
      ).toBe(0);
      expect(await row.getByRole("button", { name: "Download file" }).count()).toBe(1);
      failNextDownload = true;
      await row.getByRole("button", { name: "Download file" }).click();
      await page.getByText("Could not download this file: HTTP 404. Try again.").waitFor();
      await download(row.getByRole("button", { name: "Download file" }), "release report.md", text);
      expect(await preview.isVisible()).toBe(false);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(1);
      const archive = rail.getByRole("listitem").filter({ hasText: "archive.zip" });
      await gateway.setMethodResponse("sessions.files.download", {
        filename: "archive.zip",
        mimeType: "application/zip",
        url: "/api/artifacts/download/e2e/archive",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      await archive.hover();
      await download(archive.getByRole("button", { name: "Download file" }), "archive.zip", binary);
      await gateway.setMethodResponse("sessions.files.download", {
        filename: "release report.md",
        mimeType: "text/markdown",
        url: "/api/artifacts/download/e2e/report",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      await row.getByRole("button", { name: "Preview", exact: true }).click();
      await preview.locator(".cm-editor").waitFor();
      await download(
        preview.getByRole("button", { name: "Download file" }),
        "release report.md",
        text,
      );
      expect(requests).toEqual(["report", "report", "archive", "report"]);
      expect(
        (await gateway.getRequests("sessions.files.download")).map((request) => request.params),
      ).toEqual([
        {
          sessionKey: "agent:main:main",
          agentId: "main",
          path: "/workspace/project/release report.md",
        },
        {
          sessionKey: "agent:main:main",
          agentId: "main",
          path: "/workspace/project/release report.md",
        },
        { sessionKey: "agent:main:main", agentId: "main", path: "/workspace/project/archive.zip" },
        {
          sessionKey: "agent:main:main",
          agentId: "main",
          path: "/workspace/project/release report.md",
        },
      ]);
      expect(page.url()).toBe(originalUrl);
      expect(context.pages()).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps oversized downloads visible but disabled in Files and the preview", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const size = 8 * 1024 * 1024 + 1;
    const reason = "Files over 8 MiB are not available for download.";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "agent:main:main",
          root: "/workspace/project",
          files: [],
          browser: {
            path: "",
            entries: [{ kind: "file", name: "large.txt", path: "large.txt", size }],
          },
        },
      },
    });
    const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifacts = parent
      ? createControlUiE2eArtifactDir("file-download-size-limit", parent)
      : undefined;
    const capture = async (surface: Locator, name: string, tooltip?: Locator) => {
      if (!artifacts) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
        elements: tooltip ? [surface, tooltip] : [surface],
        animations: "disabled",
      });
      const bounds = frame.elements.map((element) => element.pixelBounds);
      const left = Math.min(...bounds.map((box) => box.x));
      const top = Math.min(...bounds.map((box) => box.y));
      const right = Math.max(...bounds.map((box) => box.x + box.width));
      const bottom = Math.max(...bounds.map((box) => box.y + box.height));
      const image = photon.PhotonImage.new_from_byteslice(frame.png);
      try {
        const crop = photon.crop(image, left, top, right, bottom);
        try {
          await writeFile(path.join(artifacts, name), Buffer.from(crop.get_bytes()));
        } finally {
          crop.free();
        }
      } finally {
        image.free();
      }
    };
    try {
      await page.goto(suite.server.baseUrl + "chat");
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".chat-workspace-rail");
      const row = rail.getByRole("listitem").filter({ hasText: "large.txt" });
      const download = row.getByRole("button", { name: "Download file", exact: true });
      await download.hover();
      await capture(rail, "oversized-list.png");
      const previous = await gateway.deferNext("sessions.files.get");
      await row.getByRole("button", { name: "large.txt", exact: true }).click();
      await gateway.waitForRequest("sessions.files.get", { after: previous });
      await gateway.rejectDeferred("sessions.files.get", {
        code: "INVALID_REQUEST",
        message: "session file is too large to preview",
        details: {
          type: "session_file_too_large",
          size,
          path: "/workspace/project/large.txt",
          maxPreviewBytes: 256 * 1024,
        },
      });
      const panel = page
        .locator(".chat-files-panel__page:visible")
        .filter({ hasText: /too large to preview|not previewable inline/ });
      await panel.waitFor();
      await capture(panel, "oversized-preview.png");
      const previewDownload = panel.getByRole("button", { name: "Download file", exact: true });
      expect(await previewDownload.count()).toBe(1);
      expect(await previewDownload.isDisabled()).toBe(true);
      await previewDownload.hover();
      await page.getByRole("tooltip").filter({ hasText: reason }).waitFor();
      await capture(
        panel,
        "oversized-preview-hover.png",
        page.getByRole("tooltip").filter({ hasText: reason }),
      );
      await panel.getByRole("button", { name: "Show in Files", exact: true }).click();
      expect(await download.isDisabled()).toBe(true);
      await download.hover();
      await page.getByRole("tooltip").filter({ hasText: reason }).waitFor();
      await capture(
        rail,
        "oversized-list-hover.png",
        page.getByRole("tooltip").filter({ hasText: reason }),
      );
      await download.dispatchEvent("click");
      expect(await gateway.getRequests("sessions.files.download")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

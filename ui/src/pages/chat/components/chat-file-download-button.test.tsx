/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { size: undefined, disabled: false },
  { size: 8 * 1024 * 1024 - 1, disabled: false },
  { size: 8 * 1024 * 1024, disabled: false },
  { size: 8 * 1024 * 1024 + 1, disabled: true },
])("keeps the download size boundary inclusive: %j", ({ size, disabled }) => {
  const download = vi.fn().mockResolvedValue(null);
  const view = mountSolid(() => (
    <FileDownloadButton
      filename="file.bin"
      scopeKey="file"
      size={size}
      download={download}
      class="download"
    />
  ));
  const button = view.container.querySelector("button");
  if (!button) {
    throw new Error("Download button is missing");
  }
  expect(button.disabled).toBe(disabled);
  expect(view.container.querySelector("openclaw-tooltip")?.content).toBe(
    disabled ? "Files over 8 MiB are not available for download." : "Download file",
  );
  button.click();
  expect(download).toHaveBeenCalledTimes(disabled ? 0 : 1);
});

it.each(["unmount", "session", "connection"])(
  "does not save bytes after %s changes",
  async (change) => {
    const bytes = createDeferredCore<Blob | null>();
    const download = vi.fn((signal: AbortSignal) => {
      void signal;
      return bytes.promise;
    });
    const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const [scope, setScope] = createSignal({ sessionKey: "agent:main:one", connectionEpoch: 1 });
    const view = mountSolid(() => (
      <FileDownloadButton
        filename="report.md"
        scopeKey={JSON.stringify(scope())}
        download={download}
        class="download"
      />
    ));
    const button = view.container.querySelector("button");
    if (!button) {
      throw new Error("Download button is missing");
    }
    button.click();
    flush();
    expect(button.disabled).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    if (change === "unmount") {
      view.unmount();
    } else {
      setScope({
        sessionKey: change === "session" ? "agent:main:two" : "agent:main:one",
        connectionEpoch: change === "connection" ? 2 : 1,
      });
      flush();
    }
    bytes.resolve(new Blob(["no longer selected"]));
    if (change === "unmount") {
      expect(download.mock.calls[0]?.[0].aborted).toBe(true);
    } else {
      await waitForSolid(() => expect(button.disabled).toBe(false));
    }
    expect(save).not.toHaveBeenCalled();
  },
);

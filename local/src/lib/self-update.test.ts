import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => files.has(path)),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }),
  writeFileSync: vi.fn((path: string, data: string, options?: { flag?: string }) => {
    if (options?.flag === "wx" && files.has(path)) {
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    files.set(path, data);
  }),
  unlinkSync: vi.fn((path: string) => {
    files.delete(path);
  }),
}));

import {
  fetchLatestRelease,
  readUpdateStatus,
  requestSelfUpdate,
  SelfUpdateError,
  UPDATE_LOG_TAIL_LINES,
} from "./self-update";

const originalOpsDir = process.env.SUBBOOST_OPS_DIR;
const originalReleaseUrl = process.env.SUBBOOST_RELEASE_URL;
const originalAppReleaseVersion = process.env.APP_RELEASE_VERSION;

function releaseResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("self-update lib", () => {
  beforeEach(() => {
    files.clear();
    process.env.SUBBOOST_OPS_DIR = "/ops";
    process.env.APP_RELEASE_VERSION = "2.11.2";
    delete process.env.SUBBOOST_RELEASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalOpsDir === undefined) delete process.env.SUBBOOST_OPS_DIR;
    else process.env.SUBBOOST_OPS_DIR = originalOpsDir;
    if (originalReleaseUrl === undefined) delete process.env.SUBBOOST_RELEASE_URL;
    else process.env.SUBBOOST_RELEASE_URL = originalReleaseUrl;
    if (originalAppReleaseVersion === undefined) delete process.env.APP_RELEASE_VERSION;
    else process.env.APP_RELEASE_VERSION = originalAppReleaseVersion;
  });

  it("reports idle when no watcher or status files exist", () => {
    expect(readUpdateStatus()).toEqual({
      watcherEnabled: false,
      status: {
        state: "idle",
        requestedAt: null,
        requestedBy: null,
        targetVersion: null,
        startedAt: null,
        finishedAt: null,
        message: null,
        logTail: null,
      },
    });
  });

  it("reads an installed watcher and a running status", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set(
      "/ops/update-status.json",
      JSON.stringify({ state: "running", targetVersion: "2.11.3", message: "正在更新……" })
    );
    const result = readUpdateStatus();
    expect(result.watcherEnabled).toBe(true);
    expect(result.status.state).toBe("running");
    expect(result.status.targetVersion).toBe("2.11.3");
  });

  it("returns the live update log tail instead of the stale status logTail", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set(
      "/ops/update-status.json",
      JSON.stringify({ state: "running", targetVersion: "2.11.3", logTail: "安装时的旧文本" })
    );
    files.set(
      "/ops/update.log",
      [
        "[+] pull 2/3",
        "df81fddd1aae Downloading 100.0MB",
        "df81fddd1aae Downloading 115.3MB",
      ].join("\n")
    );
    const result = readUpdateStatus();
    expect(result.status.logTail).toBe(
      [
        "[+] pull 2/3",
        "df81fddd1aae Downloading 100.0MB",
        "df81fddd1aae Downloading 115.3MB",
      ].join("\n")
    );
  });

  it("returns null logTail when the update log is missing", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set("/ops/update-status.json", JSON.stringify({ state: "running", targetVersion: "2.11.3" }));
    expect(readUpdateStatus().status.logTail).toBeNull();
  });

  it("returns null logTail when the update log is blank", () => {
    files.set("/ops", "");
    files.set("/ops/update.log", "\n\n");
    expect(readUpdateStatus().status.logTail).toBeNull();
  });

  it("caps the log tail at the last lines and the size window", () => {
    files.set("/ops", "");
    const lines = Array.from({ length: UPDATE_LOG_TAIL_LINES + 5 }, (_, index) => `line ${index}`);
    files.set("/ops/update.log", `${lines.join("\n")}\n`);
    const tail = readUpdateStatus().status.logTail;
    expect(tail).toBe(lines.slice(-UPDATE_LOG_TAIL_LINES).join("\n"));

    const bigLine = "x".repeat(2000);
    files.set("/ops/update.log", `${Array.from({ length: 200 }, () => bigLine).join("\n")}\nlast line\n`);
    expect(readUpdateStatus().status.logTail).toContain("last line");
    expect(readUpdateStatus().status.logTail?.split("\n").length).toBeLessThanOrEqual(
      UPDATE_LOG_TAIL_LINES
    );
  });

  it("refuses a request when the ops directory is missing", () => {
    expect(() => requestSelfUpdate("admin-1", "2.11.3")).toThrowError(SelfUpdateError);
    try {
      requestSelfUpdate("admin-1", "2.11.3");
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(503);
      expect((error as SelfUpdateError).code).toBe("CONFIGURATION_ERROR");
    }
  });

  it("refuses a request when the watcher is not installed", () => {
    files.set("/ops", "");
    expect(() => requestSelfUpdate("admin-1", "2.11.3")).toThrowError(/更新服务未安装/);
  });

  it("writes a request and a requested status when enabled", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    const status = requestSelfUpdate("admin-1", "2.11.3");
    expect(status.state).toBe("requested");
    expect(status.targetVersion).toBe("2.11.3");
    const request = JSON.parse(files.get("/ops/update-requested.json") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(request.requestedBy).toBe("admin-1");
    expect(request.targetVersion).toBe("2.11.3");
    expect(
      (JSON.parse(files.get("/ops/update-status.json") ?? "{}") as Record<string, unknown>).state
    ).toBe("requested");
  });

  it("refuses a second request while one is running", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set("/ops/update-status.json", JSON.stringify({ state: "running" }));
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(409);
      expect((error as SelfUpdateError).code).toBe("CONFLICT");
    }
  });

  it("checks the fork release manifest when SUBBOOST_RELEASE_URL is set", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => releaseResponse({ version: "2.11.3", image: "ghcr.io/jinyinghui/subboost:v2.11.3" }))
    );
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      latestTag: "v2.11.3",
      releaseUrl: "https://github.com/Jinyinghui/subboost/releases/tag/v2.11.3",
      hasUpdate: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("falls back to the upstream GitHub API without a release URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        releaseResponse({
          tag_name: "v2.11.3",
          html_url: "https://github.com/SubBoost/subboost/releases/tag/v2.11.3",
        })
      )
    );
    await expect(fetchLatestRelease()).resolves.toMatchObject({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      hasUpdate: true,
    });
  });

  it("reports a conflict when the request file already exists", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set("/ops/update-requested.json", JSON.stringify({ state: "requested" }));
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(409);
    }
  });

  it("reports a conflict when the request write collides", async () => {
    const { writeFileSync } = await import("node:fs");
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(409);
      expect((error as SelfUpdateError).code).toBe("CONFLICT");
    }
  });

  it("reports an unwritable ops directory when the request write fails", async () => {
    const { writeFileSync } = await import("node:fs");
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(503);
      expect((error as SelfUpdateError).code).toBe("CONFIGURATION_ERROR");
    }
  });

  it("cleans up the request when the status write fails", async () => {
    const { unlinkSync, writeFileSync } = await import("node:fs");
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    vi.mocked(writeFileSync).mockImplementation((path, data) => {
      if (typeof path === "string" && path.endsWith("update-status.json")) {
        throw new Error("disk full");
      }
      files.set(path as string, data as string);
    });
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(500);
      expect((error as SelfUpdateError).code).toBe("INTERNAL_ERROR");
    }
    expect(files.has("/ops/update-requested.json")).toBe(false);
    expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith("/ops/update-requested.json");
  });

  it("keeps the request when even the cleanup fails", async () => {
    const { unlinkSync, writeFileSync } = await import("node:fs");
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    vi.mocked(writeFileSync).mockImplementation((path, data) => {
      if (typeof path === "string" && path.endsWith("update-status.json")) {
        throw new Error("disk full");
      }
      files.set(path as string, data as string);
    });
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error("unlink failed");
    });
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(500);
    }
  });

  it("treats malformed watcher and status files as absent", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", "{not json");
    files.set("/ops/update-status.json", JSON.stringify({ state: "weird" }));
    const result = readUpdateStatus();
    expect(result.watcherEnabled).toBe(false);
    expect(result.status.state).toBe("idle");
  });

  it("fails closed before fetching when the current version is not stable", async () => {
    process.env.APP_RELEASE_VERSION = "2.11.2-beta.1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2-beta.1",
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      hasUpdate: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a non-GitHub release manifest URL as the release link", async () => {
    process.env.SUBBOOST_RELEASE_URL = "https://example.com/releases/release.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => releaseResponse({ version: "2.11.3" }))
    );
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      latestTag: "v2.11.3",
      releaseUrl: "https://example.com/releases/release.json",
      hasUpdate: true,
    });
  });

  it("reports no update when the release manifest has no version", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse({ image: "ghcr.io/jinyinghui/subboost" })));
    await expect(fetchLatestRelease({ fresh: true })).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("reports no update when the release manifest cannot be fetched", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse({}, 404)));
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      hasUpdate: false,
    });
  });

  it("defaults to the /ops directory when no override is set", () => {
    delete process.env.SUBBOOST_OPS_DIR;
    const result = readUpdateStatus();
    expect(result.watcherEnabled).toBe(false);
    expect(result.status.state).toBe("idle");
  });

  it("checks the fork release manifest without forcing a fresh fetch", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => releaseResponse({ version: "2.11.3", image: "ghcr.io/jinyinghui/subboost:v2.11.3" }))
    );
    await expect(fetchLatestRelease()).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      latestTag: "v2.11.3",
      releaseUrl: "https://github.com/Jinyinghui/subboost/releases/tag/v2.11.3",
      hasUpdate: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json",
      expect.objectContaining({ next: { revalidate: 3600 } })
    );
  });

  it("forces a fresh upstream check when asked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        releaseResponse({
          tag_name: "v2.11.3",
          html_url: "https://github.com/SubBoost/subboost/releases/tag/v2.11.3",
        })
      )
    );
    await expect(fetchLatestRelease({ fresh: true })).resolves.toMatchObject({
      latestVersion: "2.11.3",
      hasUpdate: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/SubBoost/subboost/releases/latest",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("reads succeeded and failed states", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set("/ops/update-status.json", JSON.stringify({ state: "succeeded" }));
    expect(readUpdateStatus().status.state).toBe("succeeded");
    files.set("/ops/update-status.json", JSON.stringify({ state: "failed", message: "boom" }));
    const result = readUpdateStatus();
    expect(result.status.state).toBe("failed");
    expect(result.status.message).toBe("boom");
  });

  it("reports no update when the release manifest is not an object", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse([])));
    await expect(fetchLatestRelease({ fresh: true })).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("reports no update when the release manifest is malformed JSON", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    await expect(fetchLatestRelease({ fresh: true })).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("reports no update when the upstream API returns a non-object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse([])));
    await expect(fetchLatestRelease()).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("reports no update when the upstream API returns malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    await expect(fetchLatestRelease()).resolves.toMatchObject({
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("reports no update when the upstream API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse({ message: "rate limited" }, 403)));
    await expect(fetchLatestRelease()).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      hasUpdate: false,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  fetchLatest: vi.fn(),
  requestPrepull: vi.fn(),
  SelfUpdateError: class SelfUpdateError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("@local/lib/api-auth", () => ({ withCurrentAdmin: mocks.admin }));
vi.mock("@local/lib/self-update", () => ({
  fetchLatestRelease: mocks.fetchLatest,
  requestPrepull: mocks.requestPrepull,
  SelfUpdateError: mocks.SelfUpdateError,
}));

const requestedPrepull = {
  state: "requested",
  targetVersion: "2.11.3",
  imageTag: null,
  message: "已提交后台拉取请求",
  updatedAt: "2026-11-11T07:00:00Z",
};

function postRequest(body?: unknown) {
  return new Request("http://local.subboost.test/api/system/update/prepull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("local system update pre-pull route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockImplementation((handler: (admin: { id: string }) => unknown) =>
      handler({ id: "admin-1" })
    );
    mocks.fetchLatest.mockResolvedValue({ latestVersion: "2.11.3" });
    mocks.requestPrepull.mockReturnValue(requestedPrepull);
  });

  it("requests a pre-pull for the given version and returns 202", async () => {
    const response = await POST(postRequest({ targetVersion: "2.11.3" }));
    expect(response.status).toBe(202);
    expect(mocks.requestPrepull).toHaveBeenCalledWith("admin-1", "2.11.3");
    await expect(response.json()).resolves.toEqual({ prepull: requestedPrepull });
  });

  it("falls back to the latest version when the body is empty", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(202);
    expect(mocks.requestPrepull).toHaveBeenCalledWith("admin-1", "2.11.3");
  });

  it("returns 400 when no version can be determined", async () => {
    mocks.fetchLatest.mockResolvedValue({ latestVersion: null });
    const response = await POST(postRequest());
    expect(response.status).toBe(400);
    expect(mocks.requestPrepull).not.toHaveBeenCalled();
  });

  it("falls back to the latest version when targetVersion is not a string", async () => {
    const response = await POST(postRequest({ targetVersion: 123 }));
    expect(response.status).toBe(202);
    expect(mocks.requestPrepull).toHaveBeenCalledWith("admin-1", "2.11.3");
  });

  it("falls back to the latest version when targetVersion is blank", async () => {
    const response = await POST(postRequest({ targetVersion: "   " }));
    expect(response.status).toBe(202);
    expect(mocks.requestPrepull).toHaveBeenCalledWith("admin-1", "2.11.3");
  });

  it("maps a concurrent update to 409", async () => {
    mocks.requestPrepull.mockImplementation(() => {
      throw new mocks.SelfUpdateError("CONFLICT", 409, "已有更新正在进行");
    });
    const response = await POST(postRequest({ targetVersion: "2.11.3" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("rethrows unexpected errors from the pre-pull request", async () => {
    mocks.requestPrepull.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(POST(postRequest({ targetVersion: "2.11.3" }))).rejects.toThrow("boom");
  });
});

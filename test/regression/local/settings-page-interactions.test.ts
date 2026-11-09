import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, any>>,
  cleanups: [] as Array<() => void>,
  enabled: false,
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  stateIndex: 0,
  switches: [] as Array<Record<string, any>>,
  userState: {
    fetchUser: vi.fn(),
    logout: vi.fn(),
    user: null as null | {
      username: string;
      subscriptionCount: number;
      quota: { maxSubscriptions: number };
    },
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: React.EffectCallback, deps?: React.DependencyList) => {
      if (!harness.enabled) return actual.useEffect(effect, deps);
      const cleanup = effect();
      if (typeof cleanup === "function") harness.cleanups.push(cleanup);
    },
    useState: (initial: unknown) => {
      if (!harness.enabled) return actual.useState(initial);
      const index = harness.stateIndex++;
      const value = Object.prototype.hasOwnProperty.call(harness.overrides, index)
        ? harness.overrides[index]
        : initial;
      const setter = vi.fn();
      harness.setters[index] = setter;
      return [value, setter];
    },
  };
});

vi.mock("lucide-react", () => ({
  LogOut: () => React.createElement("span", null, "logout"),
  Network: () => React.createElement("span", null, "network"),
  RefreshCw: () => React.createElement("span", null, "refresh"),
  ServerCog: () => React.createElement("span", null, "server"),
  ShieldCheck: () => React.createElement("span", null, "shield"),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: ({ variant: _variant, ...props }: Record<string, any>) => {
    harness.buttons.push({ variant: _variant, ...props });
    return React.createElement("button", props, props.children);
  },
}));

vi.mock("@subboost/ui/components/ui/card", () => ({
  Card: (props: Record<string, any>) => React.createElement("section", props, props.children),
  CardContent: (props: Record<string, any>) => React.createElement("div", props, props.children),
  CardHeader: (props: Record<string, any>) => React.createElement("header", props, props.children),
  CardTitle: (props: Record<string, any>) => React.createElement("h2", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/switch-field", () => ({
  SwitchField: (props: Record<string, any>) => {
    harness.switches.push(props);
    return React.createElement("button", {
      disabled: props.disabled,
      onClick: () => props.onCheckedChange(!props.checked),
      role: "switch",
    });
  },
}));

vi.mock("@subboost/ui/store/user-store", () => ({
  useUserStore: () => harness.userState,
}));

import SettingsPage from "../../../local/app/dashboard/settings/page";

function response(body: unknown, ok = true) {
  return {
    ok,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function renderSettings(overrides: Record<number, unknown> = {}) {
  harness.enabled = true;
  harness.overrides = overrides;
  harness.stateIndex = 0;
  harness.setters = [];
  harness.cleanups = [];
  harness.buttons = [];
  harness.switches = [];
  try {
    const html = renderToStaticMarkup(React.createElement(SettingsPage));
    return {
      html,
      setters: harness.setters,
      cleanups: harness.cleanups,
      buttons: harness.buttons,
      switches: harness.switches,
    };
  } finally {
    harness.enabled = false;
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("local source-import settings interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    harness.userState = {
      fetchUser: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      user: null,
    };
    vi.stubGlobal("window", { location: { href: "" } });
  });

  it("finishes immediately for an anonymous visitor and runs effect cleanup", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings();

    expect(view.html).toContain("未登录");
    expect(view.setters[1]).toHaveBeenCalledWith(false);
    expect(view.switches[0]).toMatchObject({ disabled: true, checked: false });
    expect(fetchMock).not.toHaveBeenCalled();
    view.cleanups[0]();
  });

  it("loads a valid persisted value for an authenticated administrator", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ allowUnsafeSubscriptionSources: true })));

    const view = renderSettings();
    await flushPromises();

    expect(view.html).toContain("2 / 9");
    expect(view.setters[0]).toHaveBeenCalledWith(true);
    expect(view.setters[1]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[1]).toHaveBeenLastCalledWith(false);
    expect(view.setters[3]).toHaveBeenCalledWith(null);
    expect(harness.userState.fetchUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unsuccessful response", response({}, false)],
    ["a malformed response", response({ allowUnsafeSubscriptionSources: "yes" })],
  ])("shows a load error for %s", async (_label, fetchResponse) => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse));

    const view = renderSettings();
    await flushPromises();

    expect(view.setters[3]).toHaveBeenCalledWith("加载失败，请刷新重试");
    expect(view.setters[1]).toHaveBeenLastCalledWith(false);
  });

  it("does not update state after the settings effect is cancelled", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));

    const view = renderSettings();
    view.cleanups[0]();
    resolveFetch(response({ allowUnsafeSubscriptionSources: true }));
    await flushPromises();

    expect(view.setters[0]).not.toHaveBeenCalled();
    expect(view.setters[1]).toHaveBeenCalledTimes(1);
    expect(view.setters[3]).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected settings request after cancellation", async () => {
    harness.userState.user = {
      username: "",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let rejectFetch!: (reason: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })));

    const view = renderSettings();
    expect(view.html).toContain("未登录");
    view.cleanups[0]();
    rejectFetch(new Error("cancelled request"));
    await flushPromises();

    expect(view.setters[3]).toHaveBeenCalledTimes(1);
    expect(view.setters[1]).toHaveBeenCalledTimes(1);
  });

  it("saves a toggle and redirects after logout", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 1,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: false }))
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: true }));
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings();
    await flushPromises();
    view.switches[0].onCheckedChange(true);
    await flushPromises();
    view.buttons.find((button) => button.variant === "destructive")?.onClick();
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith("/api/settings/source-import", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ allowUnsafeSubscriptionSources: true }),
    }));
    expect(view.setters[0]).toHaveBeenCalledWith(true);
    expect(view.setters[2]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
    expect(window.location.href).toBe("/login");
  });

  it.each([
    ["an unsuccessful save", response({}, false)],
    ["a malformed save", response({ allowUnsafeSubscriptionSources: "yes" })],
  ])("rolls back %s", async (_label, patchResponse) => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 1,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: true }))
      .mockResolvedValueOnce(patchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 0: true });
    await flushPromises();
    view.switches[0].onCheckedChange(false);
    await flushPromises();

    expect(view.setters[0]).toHaveBeenCalledWith(false);
    expect(view.setters[0]).toHaveBeenLastCalledWith(true);
    expect(view.setters[3]).toHaveBeenCalledWith("保存失败，请重试");
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
  });
});

describe("local system update card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    harness.userState = {
      fetchUser: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      user: null,
    };
    vi.stubGlobal("window", { location: { href: "" } });
  });

  function updateFixture(overrides: Record<string, unknown> = {}) {
    return {
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      latestTag: "v2.11.3",
      releaseUrl: "https://github.com/Jinyinghui/subboost/releases/tag/v2.11.3",
      hasUpdate: true,
      watcherEnabled: true,
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
      ...overrides,
    };
  }

  function renderUpdateCard(
    overrides: Record<number, unknown>,
    fetchImpl?: (url: string, init?: RequestInit) => unknown
  ) {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const fixture = updateFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (fetchImpl) return fetchImpl(url, init) as Response;
        if (url === "/api/system/update") return response(fixture);
        return response({ allowUnsafeSubscriptionSources: true });
      })
    );
    return { ...renderSettings(overrides), fixture };
  }

  function stopPolling(view: { cleanups: Array<() => void> }) {
    view.cleanups.forEach((cleanup) => cleanup());
  }

  it("shows a source import error when the settings load fails", () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ allowUnsafeSubscriptionSources: true })));
    const view = renderSettings({ 3: "加载失败，请刷新重试" });

    expect(view.html).toContain("加载失败，请刷新重试");
  });

  it("shows the latest version and offers the update", () => {
    const fixture = updateFixture();
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("系统更新");
    expect(view.html).toContain("v2.11.2");
    expect(view.html).toContain("v2.11.3");
    expect(view.html).toContain("查看发布说明");
    expect(view.html).toContain("发现新版本，可以一键更新。");
    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    expect(updateButton).toMatchObject({ disabled: false });
  });

  it("shows a hint when the watcher is not installed", () => {
    const view = renderUpdateCard({ 4: updateFixture({ watcherEnabled: false }) });

    expect(view.html).toContain("站内更新未启用");
    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    expect(updateButton).toMatchObject({ disabled: true });
  });

  it("shows a load error when no latest version is known", () => {
    const view = renderUpdateCard({ 4: updateFixture({ latestVersion: null, hasUpdate: false }) });

    expect(view.html).toContain("无法获取最新版本，请检查网络后重试");
  });

  it("shows nothing extra when already on the latest version", () => {
    const view = renderUpdateCard({ 4: updateFixture({ hasUpdate: false }) });

    expect(view.html).toContain("v2.11.3");
    expect(view.html).not.toContain("发现新版本");
  });

  it("shows the running state and the updating label", () => {
    const fixture = updateFixture({
      status: {
        state: "running",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: null,
        message: "正在更新……",
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("正在更新……");
    expect(view.html).toContain("更新中……");
    stopPolling(view);
  });

  it("notes the restart while polling fails during an update", () => {
    const fixture = updateFixture({
      status: {
        state: "requested",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: null,
        finishedAt: null,
        message: "已提交更新请求，等待更新服务执行……",
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture, 8: 2 });

    expect(view.html).toContain("（服务重启中）");
    stopPolling(view);
  });

  it("shows the succeeded state", () => {
    const fixture = updateFixture({
      hasUpdate: false,
      status: {
        state: "succeeded",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: "2026-11-09T04:01:00Z",
        message: "更新完成",
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("更新完成，当前已是最新版本。");
  });

  it("shows the failed state with the log tail", () => {
    const fixture = updateFixture({
      status: {
        state: "failed",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: "2026-11-09T04:01:00Z",
        message: "更新失败（exit 1），请查看服务器 /opt/subboost/ops/update.log",
        logTail: "boom\n",
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("更新失败");
    expect(view.html).toContain("boom");
  });

  it("shows the failed state without a log tail", () => {
    const fixture = updateFixture({
      status: {
        state: "failed",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: "2026-11-09T04:01:00Z",
        message: "更新失败",
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("更新失败");
  });

  it("shows a timeout when polling fails for too long", () => {
    const fixture = updateFixture({
      status: {
        state: "running",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: null,
        message: "正在更新……",
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture, 8: 50 });

    expect(view.html).toContain("更新超时，服务可能未恢复");
    stopPolling(view);
  });

  it("shows a submission error", () => {
    const view = renderUpdateCard({ 4: updateFixture(), 7: "提交更新失败，请重试" });

    expect(view.html).toContain("提交更新失败，请重试");
  });

  it("disables the buttons while checking or requesting", () => {
    const checking = renderUpdateCard({ 4: updateFixture(), 5: true });
    expect(checking.buttons.find((button) => button.children === "检查更新")).toMatchObject({
      disabled: true,
    });
    const requesting = renderUpdateCard({ 4: updateFixture(), 6: true });
    expect(requesting.buttons.find((button) => button.children === "立即更新")).toMatchObject({
      disabled: true,
    });
  });

  it("submits an update after confirmation", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const requestedStatus = {
      state: "requested",
      requestedAt: "2026-11-09T04:00:00Z",
      requestedBy: "admin-1",
      targetVersion: "2.11.3",
      startedAt: null,
      finishedAt: null,
      message: "已提交更新请求，等待更新服务执行……",
      logTail: null,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        return response({ status: requestedStatus });
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    expect(updateButton).toBeDefined();
    await updateButton?.onClick();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ targetVersion: "2.11.3" }),
      })
    );
    const statusUpdaters = view.setters[4].mock.calls.filter(
      ([arg]: Array<unknown>) => typeof arg === "function"
    );
    expect(statusUpdaters.length).toBeGreaterThan(0);
    const updater = statusUpdaters[statusUpdaters.length - 1][0] as (
      prev: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(updater(fixture)).toMatchObject({ status: requestedStatus });
    expect(updater(null as unknown as Record<string, unknown>)).toBeNull();
  });

  it("does nothing when the update is declined", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => false });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/system/update",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("hides the release link when the manifest has none", () => {
    const view = renderUpdateCard({ 4: updateFixture({ releaseUrl: null }) });

    expect(view.html).toContain("v2.11.3");
    expect(view.html).not.toContain("查看发布说明");
  });

  it("falls back to the default progress text without a status message", () => {
    const fixture = updateFixture({
      status: {
        state: "requested",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: null,
        finishedAt: null,
        message: null,
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("正在更新，服务会短暂重启，请稍候……");
    stopPolling(view);
  });

  it("reloads the status when the check button is clicked", async () => {
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const callsBefore = fetchMock.mock.calls.length;
    const checkButton = view.buttons.find((button) => button.children === "检查更新");
    await checkButton?.onClick();
    await flushPromises();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/system/update",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("shows a load error when the status check fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/system/update") throw new Error("network down");
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({});
    await flushPromises();

    expect(view.setters[7]).toHaveBeenCalledWith("加载更新状态失败，请刷新重试");
  });

  it("polls the update status while an update is running", async () => {
    vi.useFakeTimers();
    try {
      const fixture = updateFixture({
        status: {
          state: "running",
          requestedAt: "2026-11-09T04:00:00Z",
          requestedBy: "admin-1",
          targetVersion: "2.11.3",
          startedAt: "2026-11-09T04:00:01Z",
          finishedAt: null,
          message: "正在更新……",
          logTail: null,
        },
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "/api/system/update") return response(fixture);
        return response({ allowUnsafeSubscriptionSources: true });
      });
      vi.stubGlobal("fetch", fetchMock);
      harness.userState.user = {
        username: "admin",
        subscriptionCount: 2,
        quota: { maxSubscriptions: 9 },
      };
      const view = renderSettings({ 4: fixture });
      await flushPromises();

      const callsBefore = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4000);
      await flushPromises();

      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/system/update",
        expect.objectContaining({ cache: "no-store" })
      );
      stopPolling(view);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling after a failed silent refresh", async () => {
    vi.useFakeTimers();
    try {
      const fixture = updateFixture({
        status: {
          state: "running",
          requestedAt: "2026-11-09T04:00:00Z",
          requestedBy: "admin-1",
          targetVersion: "2.11.3",
          startedAt: "2026-11-09T04:00:01Z",
          finishedAt: null,
          message: "正在更新……",
          logTail: null,
        },
      });
      let updateCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "/api/system/update") {
          updateCalls += 1;
          if (updateCalls > 1) throw new Error("network down");
          return response(fixture);
        }
        return response({ allowUnsafeSubscriptionSources: true });
      });
      vi.stubGlobal("fetch", fetchMock);
      harness.userState.user = {
        username: "admin",
        subscriptionCount: 2,
        quota: { maxSubscriptions: 9 },
      };
      const view = renderSettings({ 4: fixture });
      await flushPromises();

      await vi.advanceTimersByTimeAsync(4000);
      await flushPromises();

      const errorUpdaters = view.setters[8].mock.calls.filter(
        ([arg]: Array<unknown>) => typeof arg === "function"
      );
      expect(errorUpdaters.length).toBeGreaterThan(0);
      const updater = errorUpdaters[errorUpdaters.length - 1][0] as (count: number) => number;
      expect(updater(2)).toBe(3);
      stopPolling(view);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a default message for a failed update without details", () => {
    const fixture = updateFixture({
      status: {
        state: "failed",
        requestedAt: "2026-11-09T04:00:00Z",
        requestedBy: "admin-1",
        targetVersion: "2.11.3",
        startedAt: "2026-11-09T04:00:01Z",
        finishedAt: "2026-11-09T04:01:00Z",
        message: null,
        logTail: null,
      },
    });
    const view = renderUpdateCard({ 4: fixture });

    expect(view.html).toContain("更新失败");
  });

  it("shows a generic error when the rejection message is empty", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        return response({ error: "", code: "INTERNAL_ERROR" }, false);
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    expect(view.setters[7]).toHaveBeenCalledWith("提交更新失败，请重试");
  });

  it("shows the server error when the update request is rejected", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        return response({ error: "磁盘空间不足", code: "INTERNAL_ERROR" }, false);
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    expect(view.setters[7]).toHaveBeenCalledWith("磁盘空间不足");
  });

  it("shows a generic error when the rejection has no message", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        return response({}, false);
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    expect(view.setters[7]).toHaveBeenCalledWith("提交更新失败，请重试");
  });

  it("ignores a successful update response without a status", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        return response({});
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const callsBefore = view.setters[4].mock.calls.length;
    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    const statusUpdaters = view.setters[4].mock.calls
      .slice(callsBefore)
      .filter(([arg]: Array<unknown>) => typeof arg === "function");
    expect(statusUpdaters).toHaveLength(0);
  });

  it("shows a generic error when the update request itself fails", async () => {
    vi.stubGlobal("window", { location: { href: "" }, confirm: () => true });
    const fixture = updateFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/system/update" && init?.method === "POST") {
        throw new Error("网络错误");
      }
      if (url === "/api/system/update") return response(fixture);
      return response({ allowUnsafeSubscriptionSources: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    const view = renderSettings({ 4: fixture });
    await flushPromises();

    const updateButton = view.buttons.find((button) => button.children === "立即更新");
    await updateButton?.onClick();
    await flushPromises();

    expect(view.setters[7]).toHaveBeenCalledWith("网络错误");
  });
});

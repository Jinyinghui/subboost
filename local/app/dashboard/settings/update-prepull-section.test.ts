import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UpdatePrepullSection } from "./update-prepull-section";

const idlePrepull = {
  state: "idle" as const,
  targetVersion: null,
  imageTag: null,
  message: null,
  updatedAt: null,
};

function info(overrides: Record<string, unknown> = {}) {
  return {
    hasUpdate: true,
    latestVersion: "2.11.20",
    status: { state: "idle", logTail: null },
    prepull: idlePrepull,
    prepullWatcherEnabled: true,
    ...overrides,
  };
}

describe("UpdatePrepullSection", () => {
  it("renders nothing when there is no update", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, { updateInfo: null, onPrepull: vi.fn() })
    );
    expect(html).toBe("");
    const noUpdate = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({ hasUpdate: false }),
        onPrepull: vi.fn(),
      })
    );
    expect(noUpdate).toBe("");
  });

  it("shows the not-installed hint when the pre-pull watcher is missing", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({ prepullWatcherEnabled: false }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("后台拉取未启用");
    expect(html).toContain("ensure-update-services");
  });

  it("renders nothing while an update is running", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({ status: { state: "running", logTail: null } }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toBe("");
  });

  it("shows the ready state with the target version", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          prepull: { ...idlePrepull, state: "ready" as const, targetVersion: "2.11.20" },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("v2.11.20 镜像已就绪");
  });

  it("shows the pulling state with the live log tail", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          status: { state: "idle", logTail: "df81fddd1aae Downloading 115.3MB" },
          prepull: { ...idlePrepull, state: "pulling" as const, targetVersion: "2.11.20" },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("正在后台拉取 v2.11.20 镜像");
    expect(html).toContain("df81fddd1aae Downloading 115.3MB");
  });

  it("shows the pulling state without a log tail when the update status is missing", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          status: null,
          prepull: { ...idlePrepull, state: "pulling" as const, targetVersion: "2.11.20" },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("正在后台拉取 v2.11.20 镜像");
    expect(html).toContain("等待更新服务输出日志……");
  });

  it("shows the requested state", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          prepull: { ...idlePrepull, state: "requested" as const, targetVersion: "2.11.20" },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("已提交后台拉取请求");
  });

  it("shows the failed state with a retry button", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          prepull: {
            ...idlePrepull,
            state: "failed" as const,
            targetVersion: "2.11.20",
            message: "拉取失败",
          },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("后台拉取失败：拉取失败");
    expect(html).toContain("重新拉取");
  });

  it("shows the failed state without a message or a button when the version is unknown", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, {
        updateInfo: info({
          latestVersion: null,
          prepull: { ...idlePrepull, state: "failed" as const, targetVersion: null },
        }),
        onPrepull: vi.fn(),
      })
    );
    expect(html).toContain("后台拉取失败：未知原因");
    expect(html).not.toContain("重新拉取");
  });

  it("shows the idle state with a start button", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdatePrepullSection, { updateInfo: info(), onPrepull: vi.fn() })
    );
    expect(html).toContain("正在准备后台拉取");
    expect(html).toContain("开始后台拉取");
  });
});

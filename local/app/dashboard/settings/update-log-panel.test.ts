import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { extractLatestPullProgress, UpdateLogPanel } from "./update-log-panel";

describe("extractLatestPullProgress", () => {
  it("returns null for null or empty input", () => {
    expect(extractLatestPullProgress(null)).toBeNull();
    expect(extractLatestPullProgress("")).toBeNull();
  });

  it("returns null when there is no layer progress line", () => {
    expect(extractLatestPullProgress("[+] pull 2/3\n[+] Running 1/2")).toBeNull();
  });

  it("returns the latest layer progress line", () => {
    const logTail = [
      "[+] pull 2/3",
      "df81fddd1aae Downloading 100.0MB",
      "3d7dff7022ec Download complete",
      "df81fddd1aae Downloading 115.3MB",
    ].join("\n");
    expect(extractLatestPullProgress(logTail)).toBe("df81fddd1aae Downloading 115.3MB");
  });

  it("accepts extracting and completion lines", () => {
    expect(extractLatestPullProgress("df81fddd1aae Extracting 10.2MB/184MB")).toBe(
      "df81fddd1aae Extracting 10.2MB/184MB"
    );
    expect(extractLatestPullProgress("df81fddd1aae Pull complete")).toBe("df81fddd1aae Pull complete");
  });
});

describe("UpdateLogPanel", () => {
  it("shows the waiting hint when there is no log yet", () => {
    const html = renderToStaticMarkup(React.createElement(UpdateLogPanel, { logTail: null }));
    expect(html).toContain("等待更新服务输出日志");
    expect(html).not.toContain("最新进度");
  });

  it("shows the latest progress and the full tail", () => {
    const logTail = [
      "[+] pull 2/3",
      "df81fddd1aae Downloading 115.3MB",
      "3d7dff7022ec Download complete",
    ].join("\n");
    const html = renderToStaticMarkup(React.createElement(UpdateLogPanel, { logTail }));
    expect(html).toContain("最新进度：3d7dff7022ec Download complete");
    expect(html).toContain("df81fddd1aae Downloading 115.3MB");
    expect(html).toContain("3d7dff7022ec Download complete");
  });

  it("shows the tail without a progress summary when there is no layer line", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdateLogPanel, { logTail: "[+] pull 2/3\n[+] Running 1/2" })
    );
    expect(html).toContain("[+] pull 2/3");
    expect(html).not.toContain("最新进度");
  });
});

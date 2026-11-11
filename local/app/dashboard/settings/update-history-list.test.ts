import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UpdateHistoryList } from "./update-history-list";

const succeededEntry = {
  targetVersion: "2.11.20",
  fromVersion: "2.11.19",
  state: "succeeded" as const,
  startedAt: "2026-11-11T06:00:00Z",
  finishedAt: "2026-11-11T06:05:00Z",
  message: "更新完成",
};

const failedEntry = {
  targetVersion: "2.11.19",
  fromVersion: "2.11.18",
  state: "failed" as const,
  startedAt: "2026-11-10T08:45:00Z",
  finishedAt: "2026-11-10T09:30:00Z",
  message: "更新失败（exit 1）",
};

describe("UpdateHistoryList", () => {
  it("renders nothing when there is no history", () => {
    expect(
      renderToStaticMarkup(React.createElement(UpdateHistoryList, { updateInfo: null }))
    ).toBe("");
    expect(
      renderToStaticMarkup(React.createElement(UpdateHistoryList, { updateInfo: { history: [] } }))
    ).toBe("");
  });

  it("renders succeeded and failed entries with versions", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdateHistoryList, {
        updateInfo: { history: [succeededEntry, failedEntry] },
      })
    );
    expect(html).toContain("更新记录");
    expect(html).toContain("v2.11.19 → v2.11.20");
    expect(html).toContain("成功");
    expect(html).toContain("v2.11.18 → v2.11.19");
    expect(html).toContain("失败");
    expect(html).toContain("更新失败（exit 1）");
  });

  it("renders an entry without a from version and without a message", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdateHistoryList, {
        updateInfo: {
          history: [{ ...succeededEntry, fromVersion: null, message: null }],
        },
      })
    );
    expect(html).toContain("v2.11.20");
    expect(html).not.toContain("→");
    expect(html).toContain("成功");
  });

  it("keeps an unparseable date as-is", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdateHistoryList, {
        updateInfo: {
          history: [{ ...succeededEntry, startedAt: null, finishedAt: "not-a-date" }],
        },
      })
    );
    expect(html).toContain("not-a-date");
  });

  it("renders an entry without dates or a target version", () => {
    const html = renderToStaticMarkup(
      React.createElement(UpdateHistoryList, {
        updateInfo: {
          history: [
            {
              ...succeededEntry,
              fromVersion: null,
              targetVersion: null,
              startedAt: null,
              finishedAt: null,
              message: null,
            },
          ],
        },
      })
    );
    expect(html).toContain("v?");
    expect(html).toContain("成功");
  });
});

"use client";

import * as React from "react";

export type UpdateHistoryEntryView = {
  targetVersion: string | null;
  fromVersion: string | null;
  state: "succeeded" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
};

function displayVersion(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^v/, "");
}

function formatHistoryDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function UpdateHistoryList({
  updateInfo,
}: {
  updateInfo: { history?: UpdateHistoryEntryView[] | null } | null;
}) {
  const history = updateInfo?.history ?? [];
  if (history.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-40">更新记录</p>
      <ul className="space-y-1">
        {history.map((entry, index) => {
          const from = displayVersion(entry.fromVersion);
          const to = displayVersion(entry.targetVersion);
          return (
            <li
              key={`${entry.finishedAt ?? entry.startedAt ?? ""}-${index}`}
              className="flex flex-wrap items-center gap-x-2 text-xs text-fg-70"
            >
              <span>{formatHistoryDate(entry.finishedAt ?? entry.startedAt)}</span>
              <span>
                {from ? `v${from} → ` : ""}v{to ?? "?"}
              </span>
              <span className={entry.state === "succeeded" ? "text-emerald-300" : "text-red-300"}>
                {entry.state === "succeeded" ? "成功" : "失败"}
              </span>
              {entry.state === "failed" && entry.message && (
                <span className="text-fg-40">{entry.message}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

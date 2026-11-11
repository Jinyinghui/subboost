"use client";

import * as React from "react";

import { UpdateLogPanel } from "./update-log-panel";

export type PrepullStatusView = {
  state: "idle" | "requested" | "pulling" | "ready" | "failed";
  targetVersion: string | null;
  imageTag: string | null;
  message: string | null;
  updatedAt: string | null;
};

export type UpdatePrepullSectionInfo = {
  hasUpdate: boolean;
  latestVersion: string | null;
  status?: { state: string; logTail?: string | null } | null;
  prepull?: PrepullStatusView | null;
  prepullWatcherEnabled?: boolean;
};

export function UpdatePrepullSection({
  updateInfo,
  onPrepull,
}: {
  updateInfo: UpdatePrepullSectionInfo | null;
  onPrepull: (targetVersion: string) => Promise<void>;
}) {
  if (!updateInfo?.hasUpdate) return null;
  const { prepull, prepullWatcherEnabled, latestVersion } = updateInfo;
  const targetVersion = prepull?.targetVersion ?? latestVersion;
  const updateRunning =
    updateInfo.status?.state === "requested" || updateInfo.status?.state === "running";

  if (!prepullWatcherEnabled) {
    return (
      <p className="text-xs text-amber-300">
        后台拉取未启用：请在服务器执行 subboost ensure-update-services（更新到 v2.11.20
        后需手动执行一次）。
      </p>
    );
  }
  if (updateRunning) return null;
  switch (prepull?.state) {
    case "ready":
      return (
        <p className="text-xs text-emerald-300">
          v{targetVersion} 镜像已就绪，点立即更新时无需再下载。
        </p>
      );
    case "pulling":
      return (
        <div className="space-y-2">
          <p className="text-xs text-indigo-300">
            正在后台拉取 v{targetVersion} 镜像……拉好后点立即更新只需切换，不用再下载。
          </p>
          <UpdateLogPanel logTail={updateInfo.status?.logTail ?? null} />
        </div>
      );
    case "requested":
      return <p className="text-xs text-indigo-300">已提交后台拉取请求，等待拉取服务执行……</p>;
    case "failed":
      return (
        <div className="space-y-2">
          <p className="text-xs text-red-300">后台拉取失败：{prepull?.message ?? "未知原因"}</p>
          {targetVersion && (
            <button
              type="button"
              className="text-xs text-indigo-400 hover:underline"
              onClick={() => void onPrepull(targetVersion)}
            >
              重新拉取
            </button>
          )}
        </div>
      );
    default:
      return (
        <div className="space-y-2">
          <p className="text-xs text-fg-60">检测到新版 v{targetVersion}，正在准备后台拉取……</p>
          {targetVersion && (
            <button
              type="button"
              className="text-xs text-indigo-400 hover:underline"
              onClick={() => void onPrepull(targetVersion)}
            >
              开始后台拉取
            </button>
          )}
        </div>
      );
  }
}

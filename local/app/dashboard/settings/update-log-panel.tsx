"use client";

import * as React from "react";

/** docker compose pull 在非 TTY 下输出的层进度行，如 `df81fddd1aae Downloading 115.3MB`。 */
const LAYER_PROGRESS_LINE =
  /^[0-9a-f]{12}\s+(Downloading|Extracting|Pulling|Verifying|Download complete|Pull complete)\b/;

/**
 * 从日志尾部取最新的一条层进度行，放在面板顶部当一行摘要；
 * 没有层进度行（例如还在下载清单）时返回 null。
 */
export function extractLatestPullProgress(logTail: string | null): string | null {
  if (!logTail) return null;
  const lines = logTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (LAYER_PROGRESS_LINE.test(line)) return line;
  }
  return null;
}

export function UpdateLogPanel({ logTail }: { logTail: string | null }) {
  const logRef = React.useRef<HTMLPreElement | null>(null);
  const latestProgress = extractLatestPullProgress(logTail);

  React.useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logTail]);

  return (
    <div className="space-y-2">
      {latestProgress && <p className="text-xs font-medium text-fg">最新进度：{latestProgress}</p>}
      {logTail ? (
        <pre
          ref={logRef}
          className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-ink/5 px-3 py-2 text-xs text-fg-70"
        >
          {logTail}
        </pre>
      ) : (
        <p className="text-xs text-fg-40">等待更新服务输出日志……</p>
      )}
    </div>
  );
}

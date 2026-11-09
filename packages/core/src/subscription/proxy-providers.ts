import { tryNormalizeSubscriptionUrlInput } from "@subboost/core/subscription/url-input";

/**
 * 从订阅的结构化配置里提取 proxy-providers（proxy-providers模式）。
 *
 * 注意：
 * - 订阅链接默认走 proxy-providers：仅显式标记 useProxyProviders=false 的 URL 源
 *   才以内联方式拉取/解析节点，其余 URL 源一律生成 provider
 * - 不触发任何出站请求
 * - provider 按订阅链接顺序命名：第一个 my_sub，后续顺延 my_sub_2、my_sub_3……
 *   路径 ./proxies/<name>.yaml
 */

export const PROXY_PROVIDER_BASE_NAME = "my_sub";

export function resolveProxyProviderName(index: number): string {
  return index <= 0 ? PROXY_PROVIDER_BASE_NAME : `${PROXY_PROVIDER_BASE_NAME}_${index + 1}`;
}

export function resolveProxyProviderPath(name: string): string {
  return `./proxies/${name}.yaml`;
}

export function buildProxyProvidersFromConfig(
  config: Record<string, unknown>,
  opts: { testUrl: string; testInterval: number }
): Record<string, unknown> | undefined {
  const rawSources = Array.isArray(config.sources) ? config.sources : [];
  if (rawSources.length === 0) return undefined;

  const out: Record<string, unknown> = {};
  let providerIndex = 0;

  for (const raw of rawSources) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "url") continue;
    if (item.useProxyProviders === false) continue;

    const url =
      typeof item.content === "string"
        ? (tryNormalizeSubscriptionUrlInput(item.content) ?? item.content.trim())
        : "";
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) continue;

    const name = resolveProxyProviderName(providerIndex++);
    out[name] = {
      type: "http",
      url,
      interval: 3600,
      path: resolveProxyProviderPath(name),
      "health-check": {
        enable: true,
        url: opts.testUrl,
        interval: opts.testInterval,
      },
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}


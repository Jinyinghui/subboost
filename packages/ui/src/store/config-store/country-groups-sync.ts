import { detectNodeCountries, isCountryProxyGroup } from "@subboost/core/proxy-group-advanced";
import { isSubscriptionInfoNodeName } from "@subboost/core/subscription/info-node-name";
import type { CustomProxyGroup } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import {
  buildCountryGroupDraftForRegion,
  resolveCountryGroupRegion,
} from "@subboost/ui/product/converter/advanced-mode/sections/country-groups";

/**
 * 按当前节点自动同步国家分组（每次订阅 / 节点变化时跑）：
 * - 节点里有的国家 → 对应分组启用
 * - 节点里一个都没有的国家 → 对应分组禁用（保留在列表里，不生成进配置）
 * - 节点里有、分组里没有的国家 → 自动追加分组（名字与表达式按国家列表生成）
 * - 非国家分组、以及对不上任何国家的分组：不动
 * - 没有任何国家信息的节点（包括订阅信息节点）：不参与任何分组
 * 无变化时返回原数组引用，调用方据此判断是否需要写回。
 */
export function syncCountryGroupsWithNodes(
  groups: CustomProxyGroup[],
  nodes: ParsedNode[],
): CustomProxyGroup[] {
  const names = nodes
    .filter(
      (node) =>
        node &&
        typeof node.name === "string" &&
        !isSubscriptionInfoNodeName(node.name),
    )
    .map((node) => node.name);
  const present = detectNodeCountries(names);

  let changed = false;
  const takenIds = new Set(groups.map((group) => group.id));
  const next = groups.map((group) => {
    if (!isCountryProxyGroup(group)) return group;
    const region = resolveCountryGroupRegion(group);
    if (!region) return group;
    const shouldEnable = present.has(region);
    const isEnabled = group.enabled !== false;
    if (shouldEnable === isEnabled) return group;
    changed = true;
    return shouldEnable ? { ...group, enabled: true } : { ...group, enabled: false };
  });

  const existingRegions = new Set(
    next
      .filter(isCountryProxyGroup)
      .map((group) => resolveCountryGroupRegion(group))
      .filter((region): region is NonNullable<typeof region> => region !== null),
  );
  for (const region of present) {
    if (existingRegions.has(region)) continue;
    const draft = buildCountryGroupDraftForRegion(region);
    if (!draft) continue;
    // id 沿用预置分组的惯例（地区 id）；被占用时加 country- 前缀，仍占用则加序号。
    let id: string = region;
    if (takenIds.has(id)) {
      id = `country-${region}`;
      let suffix = 2;
      while (takenIds.has(id)) {
        id = `country-${region}-${suffix}`;
        suffix += 1;
      }
    }
    takenIds.add(id);
    existingRegions.add(region);
    next.push({ ...draft, id });
    changed = true;
  }

  return changed ? next : groups;
}

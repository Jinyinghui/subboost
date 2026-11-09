import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import {
  builtinIdToType,
  getBuiltinTemplateId,
  getBuiltinTemplateSummaryMetadata,
} from "@subboost/core/templates/builtin";
import { getTemplateList } from "@subboost/core/templates";
import { validateSubBoostTemplateConfig } from "@subboost/core/templates/config-template";
import { normalizeRuleModelFromConfig } from "@subboost/core/rules/rule-model";
import type { SubBoostTemplateConfig } from "@subboost/core/types/template-config";
import type { TemplateTab } from "@subboost/server-core/templates";
import { decryptJsonObject, encryptJson } from "./crypto";
import { prisma } from "./prisma";

type LocalTemplateTab = Extract<TemplateTab, "default" | "my">;

type LocalTemplateRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  encryptedConfig: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalTemplateSummary = {
  id: string;
  name: string;
  description: string;
  downloads: number;
  engagementCount: number;
  createdAt: string;
  tags: string[];
  isOfficial: boolean;
  isPublic: boolean;
  isOwner?: boolean;
  proxyGroupCount: number | null;
  ruleCount: number | null;
};

export type LocalTemplateDetail = {
  id: string;
  name: string;
  description: string;
  kind: "config";
  config: SubBoostTemplateConfig;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function builtinSummaries(): LocalTemplateSummary[] {
  return getTemplateList().map((template) => ({
    ...getBuiltinTemplateSummaryMetadata(),
    id: getBuiltinTemplateId(template.id),
    name: template.name,
    description: template.description,
    proxyGroupCount: template.groupCount,
    ruleCount: template.ruleCount,
  }));
}

function formatLocalTemplate(row: LocalTemplateRow): LocalTemplateSummary {
  const config = decryptJsonObject(row.encryptedConfig);
  const proxyGroupCount = Array.isArray(config.enabledProxyGroups) ? config.enabledProxyGroups.length : null;
  const ruleCount = countTemplateRules(config);
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    downloads: 0,
    engagementCount: 0,
    createdAt: row.createdAt.toISOString(),
    tags: ["本地"],
    isOfficial: false,
    isPublic: false,
    isOwner: true,
    proxyGroupCount,
    ruleCount,
  };
}

function countTemplateRules(config: unknown): number | null {
  // ruleOrder 为 [] 时表示“使用默认顺序”，不是 0 条规则：按内置模板卡片
  // 同款口径统计——可见代理组的内置规则数 + 自定义规则 + 自定义规则集。
  const record = asRecord(config);
  if (!record || !Array.isArray(record.enabledProxyGroups)) return null;
  const hidden = new Set(
    Array.isArray(record.hiddenProxyGroups)
      ? record.hiddenProxyGroups.filter((id): id is string => typeof id === "string")
      : []
  );
  const ruleModel = normalizeRuleModelFromConfig(config);
  let count = ruleModel.customRuleSets.length;
  if (Array.isArray(record.customRules)) count += record.customRules.length;
  for (const groupId of record.enabledProxyGroups) {
    if (typeof groupId !== "string" || hidden.has(groupId)) continue;
    count += PROXY_GROUP_MODULES.find((module) => module.id === groupId)?.rules.length ?? 0;
  }
  return count;
}

function filterByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  if (ids.length === 0) return items;
  const allowed = new Set(ids);
  return items.filter((item) => allowed.has(item.id));
}

export async function listTemplates(
  ownerId: string | null,
  tab: LocalTemplateTab,
  ids: string[] = []
): Promise<LocalTemplateSummary[]> {
  if (tab === "default") return filterByIds(builtinSummaries(), ids);
  if (!ownerId) throw new Error("Authentication required.");

  const rows = await prisma.localTemplate.findMany({
    where: { ownerId, ...(ids.length > 0 ? { id: { in: ids } } : {}) },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(formatLocalTemplate);
}

export async function getTemplateDetail(ownerId: string | null, id: string): Promise<LocalTemplateDetail | null> {
  const builtinType = builtinIdToType(id);
  if (builtinType) {
    const summary = builtinSummaries().find((item) => item.id === id);
    return {
      id,
      name: summary?.name || builtinType,
      description: summary?.description || "",
      kind: "config",
      config: buildDefaultSubBoostTemplateConfig(builtinType),
    };
  }

  if (!ownerId) throw new Error("Authentication required.");
  const row = await prisma.localTemplate.findFirst({ where: { id, ownerId } });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    kind: "config",
    config: decryptJsonObject(row.encryptedConfig) as SubBoostTemplateConfig,
  };
}

export async function createTemplate(ownerId: string, body: unknown): Promise<LocalTemplateSummary> {
  const payload = asRecord(body);
  if (!payload) throw new Error("Invalid request body.");

  const name = asString(payload.name);
  if (!name || name.length > 100) throw new Error("Invalid name.");

  const validated = validateSubBoostTemplateConfig(payload.config);
  if (!validated.ok) throw new Error(validated.error);

  const row = await prisma.localTemplate.create({
    data: {
      ownerId,
      name,
      description: asString(payload.description).slice(0, 500),
      encryptedConfig: encryptJson(validated.config),
    },
  });
  return formatLocalTemplate(row);
}

export async function deleteTemplate(ownerId: string, id: string): Promise<boolean> {
  const row = await prisma.localTemplate.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!row) return false;
  await prisma.localTemplate.delete({ where: { id: row.id } });
  return true;
}

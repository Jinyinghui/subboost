"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@subboost/ui/components/ui/badge";
import { Button } from "@subboost/ui/components/ui/button";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { Input } from "@subboost/ui/components/ui/input";
import { toast } from "@subboost/ui/components/ui/toaster";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { resolveProxyGroupModuleName } from "@subboost/core/proxy-group-name";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { useProductInteractionAdapter } from "@subboost/ui/product/interactions";
import type { CustomProxyGroup } from "@subboost/core/types/config";
import { findGroupListenerBinding } from "./group-listener-settings";
import {
  buildCountryGroupDraft,
  isCountryProxyGroup,
  resolveCountryExpressionPatch,
  resolveCountryGroupExpression,
} from "./country-groups";

/**
 * 国家分组区（分流代理组配置内单独一区）。
 * 国家分组本质上仍是自定义代理组，这里只做快捷管理：改表达式、新增国家、
 * 删除；改名、规则、高级设置仍在下方自定义分组的完整卡片里。
 */
export function CountryGroupsSection() {
  const {
    customProxyGroups = [],
    dialerProxyGroups = [],
    proxyGroupNameOverrides = {},
    groupListeners = [],
    addCustomProxyGroup,
    removeCustomProxyGroup,
    updateCustomProxyGroup,
  } = useConfigStore();
  const [newCountryName, setNewCountryName] = React.useState("");
  const interactions = useProductInteractionAdapter();

  const countryGroups = React.useMemo(
    () => customProxyGroups.filter(isCountryProxyGroup),
    [customProxyGroups],
  );

  const getAllGroupNames = React.useCallback(() => {
    const names: string[] = [];
    for (const m of PROXY_GROUP_MODULES) {
      names.push(resolveProxyGroupModuleName(m, proxyGroupNameOverrides?.[m.id]));
    }
    for (const g of customProxyGroups) {
      names.push(g.name);
    }
    for (const g of dialerProxyGroups) {
      const name = g && typeof g.name === "string" ? g.name.trim() : "";
      if (name) names.push(name);
    }
    return names;
  }, [customProxyGroups, dialerProxyGroups, proxyGroupNameOverrides]);

  const handleAddCountry = React.useCallback(() => {
    const draft = buildCountryGroupDraft(newCountryName);
    if (!draft) return;
    if (new Set(getAllGroupNames()).has(draft.name)) {
      toast({
        title: "代理组名称已存在，请换一个名称。",
        variant: "warning",
      });
      return;
    }
    addCustomProxyGroup(draft);
    interactions.proxyGroupAdded?.({ groupType: "url-test" });
    setNewCountryName("");
  }, [addCustomProxyGroup, getAllGroupNames, interactions, newCountryName]);

  const handleDeleteGroup = React.useCallback(
    async (group: CustomProxyGroup) => {
      const listenerBinding = findGroupListenerBinding(groupListeners, {
        kind: "custom",
        id: group.id,
      });
      if (listenerBinding) {
        const ok = await confirmDialog({
          title: `确认删除「${group.name}」？`,
          description: (
            <span className="block pt-2">
              <span className="block rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 leading-6 text-amber-100/90">
                <span className="font-medium text-amber-200">警告：</span>
                该分组已绑定监听端口 {listenerBinding.port}，删除分组会一并移除该监听端口。
              </span>
            </span>
          ),
          confirmText: "删除",
          variant: "warning",
        });
        if (!ok) return;
      }
      removeCustomProxyGroup(group.id);
    },
    [groupListeners, removeCustomProxyGroup],
  );

  return (
    <div className="space-y-1.5 rounded border border-ink/10 bg-ink/[0.02] p-2">
      <div className="flex min-w-0 items-center gap-2 px-1">
        <div className="text-[11px] font-medium text-fg-50">国家分组</div>
        <Badge variant="outline" className="border-ink/10 bg-ink/5 text-[10px] text-fg-45">
          {countryGroups.length} 个
        </Badge>
        <div className="min-w-0 truncate text-[10px] text-fg-35">
          按节点自动同步：有该国节点时启用，无节点时禁用；表达式可直接改，新增国家按名字自动生成
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
        <Input
          value={newCountryName}
          onChange={(event) => setNewCountryName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleAddCountry();
          }}
          placeholder="国家名称，如 泰国 / Thailand，新增后自动生成表达式"
          className="h-7 min-w-0 border-ink/10 bg-ink/5 text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={handleAddCountry}
          title="添加国家"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {countryGroups.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-fg-40">暂无国家分组，可在上方添加</div>
      ) : (
        <div className="space-y-1">
          {countryGroups.map((group) => {
            const isEnabled = group.enabled !== false;
            return (
            <div
              key={group.id}
              className={`grid min-w-0 grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-1.5${isEnabled ? "" : " opacity-50"}`}
            >
              <div
                className="flex min-w-0 items-center gap-1 text-xs text-fg-75"
                title={group.name}
              >
                <span className="min-w-0 truncate">{group.name}</span>
                {!isEnabled && (
                  <Badge variant="outline" className="shrink-0 border-ink/10 bg-ink/5 text-[10px] text-fg-45">
                    已禁用
                  </Badge>
                )}
              </div>
              <Input
                value={resolveCountryGroupExpression(group)}
                onChange={(event) =>
                  updateCustomProxyGroup(group.id, {
                    advanced: {
                      ...group.advanced,
                      ...resolveCountryExpressionPatch(group, event.target.value),
                    },
                  })
                }
                placeholder="(?i)港|hk|hongkong|hong kong"
                title={`${group.name} 的筛选表达式`}
                className="h-7 min-w-0 border-ink/10 bg-ink/5 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-fg-35 hover:text-red-300"
                onClick={() => handleDeleteGroup(group)}
                title={`删除 ${group.name}`}
                aria-label={`删除 ${group.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

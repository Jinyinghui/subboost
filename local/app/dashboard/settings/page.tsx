"use client";

import * as React from "react";
import { LogOut, Network, RefreshCw, ServerCog, ShieldCheck } from "lucide-react";

import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { SwitchField } from "@subboost/ui/components/ui/switch-field";
import { useUserStore } from "@subboost/ui/store/user-store";

type SelfUpdateState = "idle" | "requested" | "running" | "succeeded" | "failed";

type SelfUpdateStatus = {
  state: SelfUpdateState;
  requestedAt: string | null;
  requestedBy: string | null;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  logTail: string | null;
};

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  hasUpdate: boolean;
  watcherEnabled: boolean;
  status: SelfUpdateStatus;
};

export default function SettingsPage() {
  const { user, fetchUser, logout } = useUserStore();
  const [allowUnsafeSubscriptionSources, setAllowUnsafeSubscriptionSources] = React.useState(false);
  const [sourceImportLoading, setSourceImportLoading] = React.useState(true);
  const [sourceImportSaving, setSourceImportSaving] = React.useState(false);
  const [sourceImportError, setSourceImportError] = React.useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = React.useState(false);
  const [updateRequesting, setUpdateRequesting] = React.useState(false);
  const [updateError, setUpdateError] = React.useState<string | null>(null);
  const [updatePollErrors, setUpdatePollErrors] = React.useState(0);

  const loadUpdateInfo = React.useCallback(async (silent = false) => {
    if (!silent) {
      setUpdateChecking(true);
      setUpdateError(null);
    }
    try {
      const response = await fetch("/api/system/update", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load update status.");
      const body = (await response.json()) as UpdateInfo;
      setUpdateInfo(body);
      setUpdatePollErrors(0);
    } catch {
      if (!silent) setUpdateError("加载更新状态失败，请刷新重试");
      else setUpdatePollErrors((count) => count + 1);
    } finally {
      if (!silent) setUpdateChecking(false);
    }
  }, []);

  React.useEffect(() => {
    if (!user) return;
    void loadUpdateInfo();
  }, [user, loadUpdateInfo]);

  // 更新进行中时轮询状态；服务重启期间的请求失败只计数，不报错。
  React.useEffect(() => {
    const state = updateInfo?.status.state;
    if (state !== "requested" && state !== "running") return undefined;
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      timer = window.setTimeout(() => {
        void loadUpdateInfo(true).finally(() => {
          if (!cancelled) tick();
        });
      }, 4000);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [updateInfo?.status.state, loadUpdateInfo]);

  React.useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  React.useEffect(() => {
    let cancelled = false;
    if (!user) {
      setSourceImportLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setSourceImportLoading(true);
    setSourceImportError(null);
    void fetch("/api/settings/source-import", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load source import settings.");
        const body = (await response.json()) as { allowUnsafeSubscriptionSources?: unknown };
        if (typeof body.allowUnsafeSubscriptionSources !== "boolean") {
          throw new Error("Invalid source import settings response.");
        }
        if (!cancelled) setAllowUnsafeSubscriptionSources(body.allowUnsafeSubscriptionSources);
      })
      .catch(() => {
        if (!cancelled) setSourceImportError("加载失败，请刷新重试");
      })
      .finally(() => {
        if (!cancelled) setSourceImportLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleLogout = async () => {
    await logout();
    // Clear the mounted authenticated page and its cached state after logout.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  };

  const handleUnsafeSourceToggle = async (checked: boolean) => {
    const previousValue = allowUnsafeSubscriptionSources;
    setAllowUnsafeSubscriptionSources(checked);
    setSourceImportSaving(true);
    setSourceImportError(null);

    try {
      const response = await fetch("/api/settings/source-import", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowUnsafeSubscriptionSources: checked }),
      });
      if (!response.ok) throw new Error("Unable to save source import settings.");
      const body = (await response.json()) as { allowUnsafeSubscriptionSources?: unknown };
      if (typeof body.allowUnsafeSubscriptionSources !== "boolean") {
        throw new Error("Invalid source import settings response.");
      }
      setAllowUnsafeSubscriptionSources(body.allowUnsafeSubscriptionSources);
    } catch {
      setAllowUnsafeSubscriptionSources(previousValue);
      setSourceImportError("保存失败，请重试");
    } finally {
      setSourceImportSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!updateInfo?.hasUpdate || !updateInfo.latestVersion) return;
    if (
      !window.confirm(`将更新到 v${updateInfo.latestVersion}，期间服务会短暂重启，确定吗？`)
    ) {
      return;
    }
    setUpdateRequesting(true);
    setUpdateError(null);
    try {
      const response = await fetch("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: updateInfo.latestVersion }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        status?: SelfUpdateStatus;
      } | null;
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string" && body.error ? body.error : "提交更新失败，请重试"
        );
      }
      if (body?.status) {
        setUpdateInfo((prev) => (prev ? { ...prev, status: body.status as SelfUpdateStatus } : prev));
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "提交更新失败，请重试");
    } finally {
      setUpdateRequesting(false);
    }
  };

  const updateBusy =
    updateChecking ||
    updateRequesting ||
    updateInfo?.status.state === "requested" ||
    updateInfo?.status.state === "running";

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">账户设置</h1>
          <p className="text-fg-50">本地管理员、订阅源安全、运行端点和系统更新</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">本地管理员</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-fg-40">用户名</p>
              <p className="mt-1 font-medium">{user?.username || "未登录"}</p>
            </div>
            <div>
              <p className="text-xs text-fg-40">已保存订阅</p>
              <p className="mt-1 font-medium">{user ? `${user.subscriptionCount} / ${user.quota.maxSubscriptions}` : "-"}</p>
            </div>
            <Button variant="destructive" className="gap-2" onClick={() => void handleLogout()} disabled={!user}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-emerald-500/20 p-2 text-emerald-300">
              <Network className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">订阅源安全</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <SwitchField
              label="允许本机和局域网订阅"
              description="开启后，本机、局域网及其他保留地址都可作为订阅源。仅在信任来源时开启。"
              checked={allowUnsafeSubscriptionSources}
              disabled={!user || sourceImportLoading || sourceImportSaving}
              onCheckedChange={(checked) => void handleUnsafeSourceToggle(checked)}
            />
            {sourceImportError && <p className="text-xs text-red-300">{sourceImportError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-sky-500/20 p-2 text-sky-300">
              <ServerCog className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">运行端点</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-fg-60">
            <div>
              <p className="text-xs text-fg-40">存活检查</p>
              <code className="mt-1 block rounded-md bg-ink/5 px-3 py-2 text-fg-70">/api/health/live</code>
            </div>
            <div>
              <p className="text-xs text-fg-40">就绪检查</p>
              <code className="mt-1 block rounded-md bg-ink/5 px-3 py-2 text-fg-70">/api/health/ready</code>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-violet-500/20 p-2 text-violet-300">
              <RefreshCw className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">系统更新</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-fg-60">
            <div>
              <p className="text-xs text-fg-40">当前版本</p>
              <p className="mt-1 font-medium text-fg">
                {updateInfo ? `v${updateInfo.currentVersion}` : "加载中……"}
              </p>
            </div>
            <div>
              <p className="text-xs text-fg-40">最新版本</p>
              {updateInfo ? (
                updateInfo.latestVersion ? (
                  <p className="mt-1">
                    <span className="font-medium text-fg">v{updateInfo.latestVersion}</span>
                    {updateInfo.releaseUrl && (
                      <>
                        {" "}
                        <a
                          className="text-indigo-400 hover:underline"
                          href={updateInfo.releaseUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看发布说明
                        </a>
                      </>
                    )}
                  </p>
                ) : (
                  <p className="mt-1">无法获取最新版本，请检查网络后重试</p>
                )
              ) : (
                <p className="mt-1">加载中……</p>
              )}
            </div>
            {updateInfo && !updateInfo.watcherEnabled && (
              <p className="text-xs text-amber-300">
                站内更新未启用：请先在服务器执行一次 subboost update（会安装更新服务），之后即可在此更新。
              </p>
            )}
            {updateInfo?.status.state === "requested" || updateInfo?.status.state === "running" ? (
              <p className="text-xs text-indigo-300">
                {updateInfo.status.message || "正在更新，服务会短暂重启，请稍候……"}
                {updatePollErrors > 0 && "（服务重启中）"}
              </p>
            ) : updateInfo?.status.state === "succeeded" ? (
              <p className="text-xs text-emerald-300">更新完成，当前已是最新版本。</p>
            ) : updateInfo?.status.state === "failed" ? (
              <div className="space-y-2">
                <p className="text-xs text-red-300">{updateInfo.status.message || "更新失败"}</p>
                {updateInfo.status.logTail && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-ink/5 px-3 py-2 text-xs text-fg-70">
                    {updateInfo.status.logTail}
                  </pre>
                )}
              </div>
            ) : (
              updateInfo?.hasUpdate && <p className="text-xs">发现新版本，可以一键更新。</p>
            )}
            {updatePollErrors > 45 && (
              <p className="text-xs text-red-300">更新超时，服务可能未恢复，请检查服务器状态后刷新页面。</p>
            )}
            {updateError && <p className="text-xs text-red-300">{updateError}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => void loadUpdateInfo()}
                disabled={!user || updateBusy}
              >
                检查更新
              </Button>
              <Button
                onClick={() => void handleUpdate()}
                disabled={
                  !user ||
                  updateBusy ||
                  !updateInfo?.hasUpdate ||
                  !updateInfo.watcherEnabled
                }
              >
                {updateInfo?.status.state === "requested" || updateInfo?.status.state === "running"
                  ? "更新中……"
                  : "立即更新"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

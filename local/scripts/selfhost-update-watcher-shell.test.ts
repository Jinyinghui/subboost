import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const publicRoot = path.resolve(__dirname, "../..");
const BASH_NON_INTERACTIVE_COMMAND = "exec \"$BASH\" -s";

function runBash(script: string) {
  return spawnSync("bash", ["-lc", BASH_NON_INTERACTIVE_COMMAND], {
    cwd: publicRoot,
    encoding: "utf8",
    input: script,
    timeout: 30_000,
    detached: true,
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
    },
  });
}

const PRELUDE = `
  set -Eeuo pipefail
  export SUBBOOST_SCRIPT_SOURCE_ONLY=1
  export SUBBOOST_HOME="$(mktemp -d)/subboost"
  mkdir -p "$SUBBOOST_HOME"
  source local/scripts/subboost.sh
  sudo_do() { "$@"; }
  UPDATE_WATCHER_PATH_UNIT="$SUBBOOST_HOME/subboost-update-watcher.path"
  UPDATE_WATCHER_SERVICE_UNIT="$SUBBOOST_HOME/subboost-update-watcher.service"
  systemctl() { printf 'systemctl-call=%s\\n' "$*" >> "$SUBBOOST_HOME/systemctl.log"; }
  chown() { printf 'chown-call=%s\\n' "$*" >> "$SUBBOOST_HOME/chown.log"; }
  update_cmd() { printf 'fake-update-output\\n'; }
`;

describe("website update watcher shell functions", () => {
  it("installs the watcher units and enables the path unit", () => {
    const result = runBash(`
      ${PRELUDE}
      ensure_update_watcher
      echo "--- path unit ---"
      cat "$UPDATE_WATCHER_PATH_UNIT"
      echo "--- service unit ---"
      cat "$UPDATE_WATCHER_SERVICE_UNIT"
      echo "--- watcher ---"
      cat "$OPS_WATCHER_FILE"
      echo "--- systemctl ---"
      cat "$SUBBOOST_HOME/systemctl.log"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PathModified=");
    expect(result.stdout).toContain("ops/update-requested.json");
    expect(result.stdout).toContain("ExecStart=/usr/local/bin/subboost run-update-request");
    expect(result.stdout).toContain('"installed":true');
    expect(result.stdout).toContain("systemctl-call=daemon-reload");
    expect(result.stdout).toContain("systemctl-call=enable --now subboost-update-watcher.path");
  });

  it("does nothing without a request file", () => {
    const result = runBash(`
      ${PRELUDE}
      mkdir -p "$OPS_DIR"
      run_update_request
      echo "update-called=$(test -f "$SUBBOOST_HOME/updated" && echo yes || echo no)"
      echo "status-exists=$(test -f "$OPS_STATUS_FILE" && echo yes || echo no)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("update-called=no");
    expect(result.stdout).toContain("status-exists=no");
  });

  it("consumes a request file and records a successful update", () => {
    const result = runBash(`
      ${PRELUDE}
      mkdir -p "$OPS_DIR"
      printf '{"requestedAt":"2026-11-09T00:00:00Z","requestedBy":"admin-1","targetVersion":"2.11.3"}' > "$OPS_REQUEST_FILE"
      run_update_request
      echo "request-exists=$(test -f "$OPS_REQUEST_FILE" && echo yes || echo no)"
      echo "--- status ---"
      cat "$OPS_STATUS_FILE"
      echo "--- log ---"
      cat "$OPS_UPDATE_LOG"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("request-exists=no");
    expect(result.stdout).toContain('"state": "succeeded"');
    expect(result.stdout).toContain('"targetVersion": "2.11.3"');
    expect(result.stdout).toContain('"requestedBy": "admin-1"');
    expect(result.stdout).toContain("fake-update-output");
  });

  it("records a failed update without removing the lock", () => {
    const result = runBash(`
      ${PRELUDE}
      update_cmd() { printf 'boom\\n'; return 1; }
      mkdir -p "$OPS_DIR"
      printf '{"requestedAt":"2026-11-09T00:00:00Z","requestedBy":"admin-1","targetVersion":"2.11.3"}' > "$OPS_REQUEST_FILE"
      if run_update_request; then echo "result=0"; else echo "result=$?"; fi
      echo "--- status ---"
      cat "$OPS_STATUS_FILE"
      echo "lock-exists=$(test -d "$OPS_DIR/.update-lock" && echo yes || echo no)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("result=1");
    expect(result.stdout).toContain('"state": "failed"');
    expect(result.stdout).toContain("boom");
    expect(result.stdout).toContain("lock-exists=no");
  });

  it("skips a request while another update holds the lock", () => {
    const result = runBash(`
      ${PRELUDE}
      update_cmd() { touch "$SUBBOOST_HOME/updated"; }
      mkdir -p "$OPS_DIR/.update-lock"
      printf '{"requestedAt":"2026-11-09T00:00:00Z","requestedBy":"admin-1","targetVersion":"2.11.3"}' > "$OPS_REQUEST_FILE"
      run_update_request
      echo "update-called=$(test -f "$SUBBOOST_HOME/updated" && echo yes || echo no)"
      echo "request-exists=$(test -f "$OPS_REQUEST_FILE" && echo yes || echo no)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("update-called=no");
    expect(result.stdout).toContain("request-exists=yes");
  });
});

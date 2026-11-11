import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const publicRoot = path.resolve(__dirname, "../..");
const BASH_NON_INTERACTIVE_COMMAND = "exec \"$BASH\" -s";
const POSIX_BACKUP_MODE_ASSERTIONS = process.platform === "win32"
  ? ": # NTFS permissions are verified by Windows ACL checks, not POSIX mode bits"
  : `
      [ "$unsafe_files" = "0" ]
      [ "$unsafe_dirs" = "0" ]`;

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

describe("self-host shell scripts", () => {
  it("preserves an explicit Docker config when Docker requires sudo", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      export DOCKER_CONFIG=/tmp/subboost-isolated-docker-config
      DOCKER_RUNNER="sudo docker"
      sudo() { printf 'sudo-call=%s\\n' "$*"; }
      docker_cmd info
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "sudo-call=env DOCKER_CONFIG=/tmp/subboost-isolated-docker-config docker info",
    );
  });

  it("retries http downloads in download_to_temp before failing", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      attempts_file="$home/attempts"
      printf '0\\n' > "$attempts_file"
      curl() {
        count="$(cat "$attempts_file")"
        count=$((count + 1))
        printf '%s\\n' "$count" > "$attempts_file"
        if [ "$count" -lt 3 ]; then return 22; fi
        printf 'downloaded\\n' > "$4"
        return 0
      }
      sleep() { :; }
      download_to_temp "https://example.com/release.json" "$home/release.json"
      printf 'attempts=%s\\n' "$(cat "$attempts_file")"
      printf 'content=%s\\n' "$(cat "$home/release.json")"
      printf '0\\n' > "$attempts_file"
      curl() {
        count="$(cat "$attempts_file")"
        count=$((count + 1))
        printf '%s\\n' "$count" > "$attempts_file"
        return 22
      }
      if download_to_temp "https://example.com/release.json" "$home/fail.json"; then
        printf 'unexpected-success\\n'
      else
        printf 'failed-as-expected attempts=%s\\n' "$(cat "$attempts_file")"
      fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("attempts=3");
    expect(result.stdout).toContain("content=downloaded");
    expect(result.stdout).toContain("failed-as-expected attempts=3");
    expect(result.stdout).not.toContain("unexpected-success");
  });

  it("leaves the update status file writable by the app user after ops_write_status", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      OPS_DIR="$home/ops"
      OPS_STATUS_FILE="$OPS_DIR/update-status.json"
      OPS_UPDATE_LOG="$OPS_DIR/update.log"
      mkdir -p "$OPS_DIR"
      sudo_do() { "$@"; }
      ops_write_status "failed" "更新失败（exit 1）"
      owner="$(stat -c %u "$OPS_STATUS_FILE")"
      mode="$(stat -c %a "$OPS_STATUS_FILE")"
      printf 'owner=%s mode=%s\\n' "$owner" "$mode"
      writable=no
      if [ "$owner" = "1000" ]; then writable=yes; fi
      # 其他用户写位是八进制模式的 002 位（不是权限字符串的最后一个字符）
      if [ $(( 8#$mode & 2 )) -ne 0 ]; then writable=yes; fi
      printf 'app-writable=%s\\n' "$writable"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("app-writable=yes");
    expect(result.stdout).not.toContain("app-writable=no");
  });

  it("uses prompt defaults without /dev/tty errors in non-interactive mode", () => {
    const result = runBash(`
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/install.sh
      export SUBBOOST_ASSUME_YES=0
      value="$(prompt 'Question: ' 'default-value')"
      printf 'value=%s\\n' "$value"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("value=default-value");
    expect(result.stderr).not.toContain("/dev/tty");
  });

  it("does not report Doctor OK when health checks fail", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 1; }
      set +e
      output="$(doctor_cmd 2>&1)"
      status=$?
      set -e
      printf 'status=%s\\n%s\\n' "$status" "$output"
      [ "$status" -ne 0 ]
      case "$output" in *"Doctor: OK"*) exit 44 ;; esac
      case "$output" in *"健康检查: 异常"*) exit 0 ;; *) exit 45 ;; esac
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).toContain("健康检查: 异常");
    expect(result.stdout).not.toContain("Doctor: OK");
    expect(result.stdout).toContain("ERROR: Health check failed: app is not responding.");
  });

  it("reports Doctor OK only after health checks pass", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      doctor_cmd
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("健康检查: 正常");
    expect(result.stdout).toContain("Doctor: OK");
  });

  it("loads SUBBOOST_PORT from .env before doctor health checks", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31041
SUBBOOST_PORT=31041
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      unset SUBBOOST_PORT APP_URL
      source local/scripts/subboost.sh
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl_urls="$home/curl-urls"
      : > "$curl_urls"
      curl() {
        printf '%s\\n' "$*" >> "$curl_urls"
        case "$*" in
          *"http://127.0.0.1:31041/api/health/"*) return 0 ;;
        esac
        return 1
      }
      doctor_cmd
      cat "$curl_urls"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Doctor: OK");
    expect(result.stdout).toContain("http://127.0.0.1:31041/api/health/live");
    expect(result.stdout).toContain("http://127.0.0.1:31041/api/health/ready");
    expect(result.stdout).not.toContain("http://127.0.0.1:3000/api/health");
  });

  it("waits for health before reporting update status", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=3
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_calls_file="$home/docker-calls"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          printf '%s\\n' "$*" >> "$docker_calls_file"
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull") return 0 ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl_count_file="$home/curl-count"
      ready_threshold=5
      printf '0\\n' > "$curl_count_file"
      curl() {
        count="$(cat "$curl_count_file")"
        count=$((count + 1))
        printf '%s\\n' "$count" > "$curl_count_file"
        case "$*" in
          *"/api/health/live"*) return 0 ;;
          *"/api/health/ready"*) [ "$count" -ge "$ready_threshold" ]; return $? ;;
        esac
        return 1
      }
      update_cmd
      printf 'curl_count=%s\\n' "$(cat "$curl_count_file")"
      cat "$docker_calls_file"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("健康检查: 正常");
    expect(result.stdout).not.toContain("健康检查: 异常");
    // wait_for_health checks live once per attempt, then status_cmd performs one final live+ready check.
    expect(result.stdout).toContain("curl_count=8");
    expect(result.stdout).toContain("up -d --no-deps cron");
  }, 10_000);

  it("restarts rollback cron without recreating the healthy old app", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      release_dir="$home/release"
      mkdir -p "$release_dir" "$home/bin"
      cat > "$release_dir/release.json" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
      printf 'services:\n  app:\n    image: \${SUBBOOST_IMAGE}\n' > "$release_dir/docker-compose.image.yml"
      printf '#!/usr/bin/env bash\necho new-manager\n' > "$release_dir/subboost-manager"
      printf '#!/usr/bin/env bash\necho old-manager\n' > "$home/bin/subboost"
      cat > "$home/.env" <<ENV
SUBBOOST_RELEASE_URL=file://$release_dir/release.json
SUBBOOST_IMAGE=old-image
SUBBOOST_CANDIDATE_IMAGE=old-candidate-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_calls_file="$home/docker-calls"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          printf '%s\\n' "$*" >> "$docker_calls_file"
          printf 'image=%s candidate_image=%s command=%s\\n' "\${SUBBOOST_IMAGE:-}" "\${SUBBOOST_CANDIDATE_IMAGE:-}" "$*" >> "$docker_calls_file"
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config" | *" pull" | *" stop cron app") return 0 ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"* | *"pg_restore --clean"*) cat >/dev/null; return 0 ;;
            *"candidate-compose.yml up -d --no-deps cron") return 1 ;;
            *" up -d "*) return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
          printf 'sha256:old-image\\n'
        fi
        return 0
      }
      curl() { return 0; }
      update_status=0
      if update_cmd; then
        :
      else
        update_status=$?
      fi
      printf 'update_status=%s parent_image=%s parent_candidate_image=%s\\n' "$update_status" "$SUBBOOST_IMAGE" "$SUBBOOST_CANDIDATE_IMAGE"
      cat "$docker_calls_file"
      [ "$update_status" -eq 1 ]
    `;

    const result = runBash(script);

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Candidate update failed: candidate cron startup failed");
    expect(result.stdout).toContain("Previous version restored successfully.");
    expect(result.stdout).toContain(
      "update_status=1 parent_image=old-image parent_candidate_image=old-candidate-image",
    );
    expect(result.stdout).toMatch(/image=new-image candidate_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps cron$/m);
    expect(result.stdout).toMatch(/image=new-image candidate_image=new-image command=compose.*candidate-compose\.yml stop cron app$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d db$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d app$/m);
    expect(result.stdout).toMatch(/image=old-image candidate_image=old-candidate-image command=compose.*old-compose\.yml up -d --no-deps cron$/m);
    expect(result.stdout).not.toMatch(/old-compose\.yml.*up -d cron(?:\s|$)/);
  }, 10_000);

  it("uses refreshed release metadata before pulling during update", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      release_dir="$home/release"
      mkdir -p "$release_dir" "$home/bin"
      cat > "$release_dir/release.json" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
      printf 'services:\\n  app:\\n    image: \${SUBBOOST_IMAGE}\\n' > "$release_dir/docker-compose.image.yml"
      printf '#!/usr/bin/env bash\\necho manager\\n' > "$release_dir/subboost-manager"
      cat > "$home/.env" <<ENV
SUBBOOST_RELEASE_URL=file://$release_dir/release.json
SUBBOOST_IMAGE=old-image
SUBBOOST_CANDIDATE_IMAGE=old-candidate-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      install_secret_file() { cp "$1" "$2"; }
      read_env_file() { cat "$ENV_FILE"; }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        printf 'command=%s\n' "$*" >> "$docker_log"
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *"candidate-compose.yml"*)
              printf 'candidate_image=%s candidate_release_image=%s command=%s\n' "\${SUBBOOST_IMAGE:-}" "\${SUBBOOST_CANDIDATE_IMAGE:-}" "$*" >> "$docker_log"
              ;;
          esac
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull")
              printf 'pull_image=%s\\n' "\${SUBBOOST_IMAGE:-}" >> "$docker_log"
              return 0
              ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      update_cmd
      cat "$docker_log"
      cat "$home/.env"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pull_image=new-image");
    expect(result.stdout).not.toContain("candidate_image=old-image");
    expect(result.stdout).not.toContain("candidate_release_image=old-candidate-image");
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml config$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml config --services$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml pull$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d db$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps app$/m);
    expect(result.stdout).toMatch(/candidate_image=new-image candidate_release_image=new-image command=compose.*candidate-compose\.yml up -d --no-deps cron$/m);
    expect(result.stdout).toContain("SUBBOOST_IMAGE=new-image");
    expect(result.stdout).toContain("SUBBOOST_CANDIDATE_IMAGE=new-image");
    expect(result.stdout).toContain("SUBBOOST_COMPOSE_URL=file://");
    expect(result.stdout).toContain("SUBBOOST_MANAGER_URL=file://");
    const pullIndex = result.stdout.search(/^command=compose.* pull$/m);
    const pauseIndex = result.stdout.indexOf(" stop cron app");
    const dumpIndex = result.stdout.indexOf("pg_dump -Fc");
    const candidateStartIndex = result.stdout.indexOf("candidate-compose.yml", dumpIndex);
    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(pauseIndex).toBeGreaterThan(pullIndex);
    expect(dumpIndex).toBeGreaterThan(pauseIndex);
    expect(candidateStartIndex).toBeGreaterThan(dumpIndex);
  }, 10_000);

  it("fails the update instead of silently re-pulling the current image when the manifest download fails", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/bin"
      cat > "$home/.env" <<ENV
SUBBOOST_RELEASE_URL=file://$home/release/missing.json
SUBBOOST_IMAGE=old-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=test-password
DATABASE_URL=postgres://subboost:test-password@127.0.0.1:5432/subboost
ENCRYPTION_KEY=key
JWT_SECRET=test-jwt-secret
CRON_SECRET=test-cron-secret
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        printf 'command=%s\\n' "$*" >> "$docker_log"
        return 0
      }
      update_status=0
      ( update_cmd ) || update_status=$?
      cat "$docker_log"
      cat "$home/.env"
      printf 'update_status=%s\n' "$update_status"
    `;

    const result = runBash(script);

    expect(result.stdout).toContain("update_status=1");
    expect(result.stderr).toContain("Release manifest unavailable; update aborted.");
    expect(result.stdout).not.toContain("pull_image=");
    expect(result.stdout).toContain("SUBBOOST_IMAGE=old-image");
  }, 10_000);

  it("still updates the current image when no release URL is configured", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/bin"
      cat > "$home/.env" <<ENV
SUBBOOST_IMAGE=old-image
SUBBOOST_CANDIDATE_IMAGE=old-candidate-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=test-password
DATABASE_URL=postgres://subboost:test-password@127.0.0.1:5432/subboost
ENCRYPTION_KEY=key
JWT_SECRET=test-jwt-secret
CRON_SECRET=test-cron-secret
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      install_secret_file() { cp "$1" "$2"; }
      read_env_file() { cat "$ENV_FILE"; }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        printf 'command=%s\\n' "$*" >> "$docker_log"
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            *\"candidate-compose.yml\"*)
              printf 'candidate_image=%s candidate_release_image=%s command=%s\\n' "\${SUBBOOST_IMAGE:-}" "\${SUBBOOST_CANDIDATE_IMAGE:-}" "$*" >> "$docker_log"
              ;;
          esac
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull")
              printf 'pull_image=%s\\n' "\${SUBBOOST_IMAGE:-}" >> "$docker_log"
              return 0
              ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      update_cmd
      cat "$docker_log"
      cat "$home/.env"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("updating current image and compose only");
    expect(result.stdout).toContain("pull_image=old-image");
    expect(result.stdout).toContain("SUBBOOST_IMAGE=old-image");
  }, 10_000);

  it("migrates old fixed official update sources to stable latest", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      mkdir -p "$home/bin"
      cat > "$home/.env" <<'ENV'
SUBBOOST_RELEASE_URL=https://github.com/SubBoost/subboost/releases/download/v2.4.0/release.json
SUBBOOST_IMAGE=old-image
POSTGRES_DB=subboost
POSTGRES_USER=subboost
POSTGRES_PASSWORD=password
DATABASE_URL=postgresql://subboost:password@db:5432/subboost?schema=public
ENCRYPTION_KEY=key
JWT_SECRET=jwt
CRON_SECRET=cron
APP_URL=http://127.0.0.1:31000
SUBBOOST_PORT=31000
ENV
      : > "$home/docker-compose.yml"
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      export SUBBOOST_BIN="$home/bin/subboost"
      export SUBBOOST_DOCTOR_HEALTH_ATTEMPTS=1
      export SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS=0
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      install_secret_file() { cp "$1" "$2"; }
      read_env_file() { cat "$ENV_FILE"; }
      download_log="$home/download-log"
      : > "$download_log"
      download_to_temp() {
        printf '%s\\n' "$1" >> "$download_log"
        case "$1" in
          *release.json)
            cat > "$2" <<'JSON'
{"image":"new-image","composeUrl":"docker-compose.image.yml","managerUrl":"subboost-manager"}
JSON
            ;;
          *)
            printf 'asset\\n' > "$2"
            ;;
        esac
      }
      docker_log="$home/docker-log"
      : > "$docker_log"
      docker() {
        if [ "$1" = "info" ]; then return 0; fi
        if [ "$1" = "compose" ]; then
          case "$*" in
            "compose version"*) return 0 ;;
            *" config --services") printf 'app\\ndb\\ncron\\n'; return 0 ;;
            *" config") return 0 ;;
            *" pull")
              printf 'pull_image=%s\\n' "\${SUBBOOST_IMAGE:-}" >> "$docker_log"
              return 0
              ;;
            *"pg_dump -Fc"*) printf 'custom-dump'; return 0 ;;
            *"pg_restore --list"*) cat >/dev/null; return 0 ;;
            *" up -d --remove-orphans") return 0 ;;
            *" up -d --no-deps --force-recreate app") return 0 ;;
            *" ps -q app") printf 'app-id\\n'; return 0 ;;
            *" ps -q db") printf 'db-id\\n'; return 0 ;;
            *" ps -q cron") printf 'cron-id\\n'; return 0 ;;
          esac
        fi
        if [ "$1" = "inspect" ]; then
          case "$*" in
            *"{{.Image}}"*) printf 'sha256:old-image\\n'; return 0 ;;
            *".State.Status"*) printf 'running\\n'; return 0 ;;
            *".State.Health"*) printf 'healthy\\n'; return 0 ;;
          esac
        fi
        return 0
      }
      curl() { return 0; }
      update_cmd
      cat "$download_log"
      cat "$docker_log"
      cat "$home/.env"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Detected old fixed release update source");
    expect(result.stdout).toContain("https://github.com/SubBoost/subboost/releases/latest/download/release.json");
    expect(result.stdout).toContain("pull_image=new-image");
    expect(result.stdout).toContain(
      "SUBBOOST_RELEASE_URL=https://github.com/SubBoost/subboost/releases/latest/download/release.json"
    );
  }, 10_000);

  it("updates exact env keys without removing similarly prefixed names", () => {
    const script = `
      set -Eeuo pipefail
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      install_secret_file() {
        cp "$1" "$2"
      }
      read_env_file() {
        cat "$ENV_FILE"
      }
      cat > "$ENV_FILE" <<'ENV'
SUBBOOST_PORT_EXTRA=keep
SUBBOOST_PORT=3000
APP_URL=http://old.example
ENV
      write_env_value SUBBOOST_PORT 31000
      cat "$ENV_FILE"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SUBBOOST_PORT_EXTRA=keep");
    expect(result.stdout).toContain("SUBBOOST_PORT=31000");
    expect(result.stdout).not.toContain("SUBBOOST_PORT=3000");
  });

  it("prunes old backups without parsing ls output", () => {
    const script = `
      set -Eeuo pipefail
      base="$(mktemp -d)"
      home="$base/subboost home"
      mkdir -p "$home/backups"
      trap 'rm -rf "$base"' EXIT
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      export SUBBOOST_HOME="$home"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      load_env() { :; }
      compose() {
        case "$*" in
          *"pg_dump -Fc"*) printf 'custom-dump' ;;
          *"pg_restore --list"*) cat >/dev/null ;;
        esac
      }
      cat > "$ENV_FILE" <<'ENV'
POSTGRES_DB=subboost
POSTGRES_USER=subboost
ENV
      for i in $(seq -w 1 12); do
        : > "$BACKUP_DIR/subboost-20240101T0000\${i}Z.dump"
        : > "$BACKUP_DIR/subboost-20240101T0000\${i}Z.env"
      done
      backup_cmd >/dev/null
      sql_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'subboost-*.dump' | wc -l | tr -d '[:space:]')"
      env_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'subboost-*.env' | wc -l | tr -d '[:space:]')"
      unsafe_files="$(find "$BACKUP_DIR" -maxdepth 1 -type f ! -perm 600 | wc -l | tr -d '[:space:]')"
      unsafe_dirs="$(find "$BACKUP_DIR" -maxdepth 0 -type d ! -perm 700 | wc -l | tr -d '[:space:]')"
      printf 'sql=%s env=%s unsafe_files=%s unsafe_dirs=%s\\n' "$sql_count" "$env_count" "$unsafe_files" "$unsafe_dirs"
      [ "$sql_count" = "10" ]
      [ "$env_count" = "10" ]
      ${POSIX_BACKUP_MODE_ASSERTIONS}
      [ ! -e "$BACKUP_DIR/subboost-20240101T000001Z.dump" ]
      [ ! -e "$BACKUP_DIR/subboost-20240101T000001Z.env" ]
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sql=10 env=10");
    if (process.platform !== "win32") {
      expect(result.stdout).toContain("unsafe_files=0 unsafe_dirs=0");
    }
  });

  it("prunes old images while keeping the current and previous ones", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      removed_file="$home/removed"
      : > "$removed_file"
      docker_cmd() {
        case "$1" in
          inspect) printf 'sha256:current-id\\n' ;;
          ps) printf 'ghcr.io/jinyinghui/subboost:v2.11.20\\n' ;;
          images)
            printf 'sha256:current-id ghcr.io/jinyinghui/subboost:v2.11.20\\n'
            printf 'sha256:prev-id ghcr.io/jinyinghui/subboost:v2.11.19\\n'
            printf 'sha256:old-id ghcr.io/jinyinghui/subboost:v2.11.18\\n'
            printf 'sha256:older-id ghcr.io/jinyinghui/subboost:v2.11.17\\n'
            ;;
          image) printf 'removed=%s\\n' "$3" >> "$removed_file" ;;
        esac
        return 0
      }
      prune_old_images "ghcr.io/jinyinghui/subboost:v2.11.20" "sha256:prev-id"
      cat "$removed_file"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed=sha256:old-id");
    expect(result.stdout).toContain("removed=sha256:older-id");
    expect(result.stdout).not.toContain("removed=sha256:current-id");
    expect(result.stdout).not.toContain("removed=sha256:prev-id");
    expect(result.stdout).toContain("Pruned old image: ghcr.io/jinyinghui/subboost:v2.11.18");
  });

  it("appends update history newest-first and caps the entries", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      OPS_DIR="$home/ops"
      OPS_HISTORY_FILE="$OPS_DIR/update-history.json"
      UPDATE_HISTORY_MAX_ENTRIES=3
      mkdir -p "$OPS_DIR"
      sudo_do() { "$@"; }
      ops_append_history "2.11.19" "2.11.20" "succeeded" "2026-11-11T06:00:00Z" "2026-11-11T06:05:00Z" "更新完成"
      ops_append_history "2.11.18" "2.11.19" "failed" "2026-11-10T08:45:00Z" "2026-11-10T09:30:00Z" "更新失败（exit 1）"
      ops_append_history "2.11.17" "2.11.18" "succeeded" "2026-11-10T06:00:00Z" "2026-11-10T06:05:00Z" "更新完成"
      ops_append_history "2.11.16" "2.11.17" "succeeded" "2026-11-09T06:00:00Z" "2026-11-09T06:05:00Z" "更新完成"
      cat "$OPS_HISTORY_FILE"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    // 4 次追加、上限 3 条：最早那条（2.11.20）被挤掉，剩下 3 条按最新在前排列。
    expect(result.stdout).toContain('"targetVersion": "2.11.19"');
    expect(result.stdout).toContain('"targetVersion": "2.11.18"');
    expect(result.stdout).toContain('"targetVersion": "2.11.17"');
    expect(result.stdout).not.toContain('"targetVersion": "2.11.20"');
    expect(result.stdout.indexOf('"targetVersion": "2.11.17"')).toBeLessThan(
      result.stdout.indexOf('"targetVersion": "2.11.18"')
    );
  });

  it("auto-update check requests an update when enabled and a newer version exists", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_HOME="$home"
      mkdir -p "$home/ops"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/jinyinghui/subboost:v2.11.19
SUBBOOST_RELEASE_URL=file://$home/release.json
ENV
      cat > "$home/release.json" <<'JSON'
{"version": "2.11.20", "image": "ghcr.io/jinyinghui/subboost:v2.11.20"}
JSON
      printf '{"enabled": true}\\n' > "$home/ops/auto-update.json"
      source local/scripts/subboost.sh
      auto_update_check
      printf 'update-request=%s\\n' "$(test -f "$home/ops/update-requested.json" && echo yes || echo no)"
      printf 'prepull-request=%s\\n' "$(test -f "$home/ops/prepull-requested.json" && echo yes || echo no)"
      cat "$home/ops/update-requested.json"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("update-request=yes");
    expect(result.stdout).toContain("prepull-request=no");
    expect(result.stdout).toContain('"targetVersion":"2.11.20"');
  });

  it("auto-update check only pre-pulls when auto-update is disabled", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_HOME="$home"
      mkdir -p "$home/ops"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/jinyinghui/subboost:v2.11.19
SUBBOOST_RELEASE_URL=file://$home/release.json
ENV
      cat > "$home/release.json" <<'JSON'
{"version": "2.11.20", "image": "ghcr.io/jinyinghui/subboost:v2.11.20"}
JSON
      printf '{"enabled": false}\\n' > "$home/ops/auto-update.json"
      source local/scripts/subboost.sh
      auto_update_check
      printf 'update-request=%s\\n' "$(test -f "$home/ops/update-requested.json" && echo yes || echo no)"
      printf 'prepull-request=%s\\n' "$(test -f "$home/ops/prepull-requested.json" && echo yes || echo no)"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("update-request=no");
    expect(result.stdout).toContain("prepull-request=yes");
  });

  it("auto-update check does nothing when already on the latest version", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_HOME="$home"
      mkdir -p "$home/ops"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/jinyinghui/subboost:v2.11.20
SUBBOOST_RELEASE_URL=file://$home/release.json
ENV
      cat > "$home/release.json" <<'JSON'
{"version": "2.11.20", "image": "ghcr.io/jinyinghui/subboost:v2.11.20"}
JSON
      printf '{"enabled": true}\\n' > "$home/ops/auto-update.json"
      source local/scripts/subboost.sh
      auto_update_check
      printf 'update-request=%s\\n' "$(test -f "$home/ops/update-requested.json" && echo yes || echo no)"
      printf 'prepull-request=%s\\n' "$(test -f "$home/ops/prepull-requested.json" && echo yes || echo no)"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("update-request=no");
    expect(result.stdout).toContain("prepull-request=no");
  });

  it("pre-pull request pulls the target image and records a ready status", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_HOME="$home"
      mkdir -p "$home/ops"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/jinyinghui/subboost:v2.11.19
SUBBOOST_RELEASE_URL=file://$home/release.json
ENV
      cat > "$home/release.json" <<'JSON'
{"version": "2.11.20", "image": "ghcr.io/jinyinghui/subboost:v2.11.20", "composeUrl": "candidate-compose.yml"}
JSON
      cat > "$home/candidate-compose.yml" <<'YAML'
services:
  app:
    image: \${SUBBOOST_IMAGE}
YAML
      printf '{"requestedAt":"2026-11-11T07:00:00Z","requestedBy":"admin-1","targetVersion":"2.11.20"}\\n' > "$home/ops/prepull-requested.json"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      docker_cmd() {
        printf 'docker-call=%s\\n' "$*"
        return 0
      }
      run_prepull_request
      cat "$home/ops/prepull-status.json"
      cat "$home/ops/update.log"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docker-call=compose");
    expect(result.stdout).toContain("pull");
    expect(result.stdout).toContain('"state": "ready"');
    expect(result.stdout).toContain('"targetVersion": "2.11.20"');
    expect(result.stdout).toContain('"imageTag": "ghcr.io/jinyinghui/subboost:v2.11.20"');
  });

  it("installs the pre-pull watcher and auto-update timer units", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      source local/scripts/subboost.sh
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      OPS_DIR="$home/ops"
      OPS_PREPULL_REQUEST_FILE="$OPS_DIR/prepull-requested.json"
      OPS_PREPULL_WATCHER_FILE="$OPS_DIR/prepull-watcher.json"
      PREPULL_WATCHER_PATH_UNIT="$home/prepull-watcher.path"
      PREPULL_WATCHER_SERVICE_UNIT="$home/prepull-watcher.service"
      AUTO_UPDATE_TIMER_UNIT="$home/auto-update.timer"
      AUTO_UPDATE_SERVICE_UNIT="$home/auto-update.service"
      sudo_do() { "$@"; }
      systemctl() { printf 'systemctl-call=%s\\n' "$*"; return 0; }
      ensure_prepull_watcher
      ensure_auto_update_timer
      printf 'prepull-service=%s\\n' "$(grep -c 'run-prepull-request' "$home/prepull-watcher.service")"
      printf 'timer-calendar=%s\\n' "$(grep -c 'OnCalendar=Sun 03:00' "$home/auto-update.timer")"
      printf 'timer-service=%s\\n' "$(grep -c 'auto-update-check' "$home/auto-update.service")"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prepull-service=1");
    expect(result.stdout).toContain("timer-calendar=1");
    expect(result.stdout).toContain("timer-service=1");
    expect(result.stdout).toContain("systemctl-call=daemon-reload");
    expect(result.stdout).toContain("systemctl-call=enable --now subboost-prepull-watcher.path");
    expect(result.stdout).toContain("systemctl-call=enable --now subboost-auto-update.timer");
  });

  it("records a failed pre-pull when the manifest cannot be downloaded", () => {
    const script = `
      set -Eeuo pipefail
      export SUBBOOST_SCRIPT_SOURCE_ONLY=1
      home="$(mktemp -d)"
      trap 'rm -rf "$home"' EXIT
      export SUBBOOST_HOME="$home"
      mkdir -p "$home/ops"
      cat > "$home/.env" <<'ENV'
SUBBOOST_IMAGE=ghcr.io/jinyinghui/subboost:v2.11.19
SUBBOOST_RELEASE_URL=https://example.com/release.json
ENV
      printf '{"requestedAt":"2026-11-11T07:00:00Z","requestedBy":"admin-1","targetVersion":"2.11.20"}\\n' > "$home/ops/prepull-requested.json"
      source local/scripts/subboost.sh
      sudo_do() { "$@"; }
      curl() { return 22; }
      sleep() { :; }
      if run_prepull_request; then printf 'unexpected-success\\n'; else printf 'failed-as-expected\\n'; fi
      cat "$home/ops/prepull-status.json"
    `;

    const result = runBash(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("failed-as-expected");
    expect(result.stdout).not.toContain("unexpected-success");
    expect(result.stdout).toContain('"state": "failed"');
  });
});

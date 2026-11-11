#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_HOME="/opt/subboost"
DEFAULT_STABLE_RELEASE_URL="https://github.com/SubBoost/subboost/releases/latest/download/release.json"
DEFAULT_BACKUP_RETENTION_COUNT="10"
SUBBOOST_HOME="${SUBBOOST_HOME:-$DEFAULT_HOME}"
ENV_FILE="$SUBBOOST_HOME/.env"
COMPOSE_FILE="$SUBBOOST_HOME/docker-compose.yml"
BACKUP_DIR="$SUBBOOST_HOME/backups"
TMP_DIR="${TMPDIR:-/tmp}/subboost-manager.$$"
# Website-initiated updates: the app container (which cannot reach the host
# Docker daemon) writes a request file here through a bind mount; a systemd
# path unit watches it and runs `subboost run-update-request`.
OPS_DIR="$SUBBOOST_HOME/ops"
OPS_REQUEST_FILE="$OPS_DIR/update-requested.json"
OPS_STATUS_FILE="$OPS_DIR/update-status.json"
OPS_WATCHER_FILE="$OPS_DIR/watcher.json"
OPS_UPDATE_LOG="$OPS_DIR/update.log"
UPDATE_WATCHER_PATH_UNIT="/etc/systemd/system/subboost-update-watcher.path"
UPDATE_WATCHER_SERVICE_UNIT="/etc/systemd/system/subboost-update-watcher.service"
# 后台预拉取：网站发现新版时先把镜像拉好，点更新时只做切换。
OPS_PREPULL_REQUEST_FILE="$OPS_DIR/prepull-requested.json"
OPS_PREPULL_STATUS_FILE="$OPS_DIR/prepull-status.json"
OPS_PREPULL_WATCHER_FILE="$OPS_DIR/prepull-watcher.json"
PREPULL_WATCHER_PATH_UNIT="/etc/systemd/system/subboost-prepull-watcher.path"
PREPULL_WATCHER_SERVICE_UNIT="/etc/systemd/system/subboost-prepull-watcher.service"
# 更新记录（网站只读）与定时自动更新开关（网站写，定时任务读）。
OPS_HISTORY_FILE="$OPS_DIR/update-history.json"
OPS_AUTO_UPDATE_FILE="$OPS_DIR/auto-update.json"
UPDATE_HISTORY_MAX_ENTRIES="20"
AUTO_UPDATE_TIMER_UNIT="/etc/systemd/system/subboost-auto-update.timer"
AUTO_UPDATE_SERVICE_UNIT="/etc/systemd/system/subboost-auto-update.service"
# UID of the `node` user the app container runs as (official node image).
OPS_APP_UID="1000"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

is_root() {
  [ "$(id -u)" = "0" ]
}

sudo_do() {
  if is_root; then "$@"; else sudo "$@"; fi
}

prepare_private_directory() {
  local directory="$1"
  sudo_do mkdir -p "$directory"
  sudo_do chmod 700 "$directory"
  if ! is_root; then sudo_do chown "$(id -u):$(id -g)" "$directory"; fi
}

install_secret_file() {
  local source="$1"
  local destination="$2"
  sudo_do install -m 600 "$source" "$destination"
  if ! is_root; then
    sudo_do chown "$(id -u):$(id -g)" "$destination"
  fi
}

docker_runner() {
  if docker info >/dev/null 2>&1; then
    printf 'docker\n'
    return 0
  fi
  if ! is_root && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    printf 'sudo docker\n'
    return 0
  fi
  printf 'docker\n'
}

ensure_docker_runner() {
  if [ -z "${DOCKER_RUNNER:-}" ]; then
    DOCKER_RUNNER="$(docker_runner)"
  fi
}

docker_cmd() {
  ensure_docker_runner
  if [ "$DOCKER_RUNNER" = "sudo docker" ]; then sudo docker "$@"; else docker "$@"; fi
}

compose() {
  compose_files "$ENV_FILE" "$COMPOSE_FILE" "$@"
}

compose_files() {
  local env_file="$1"
  local compose_file="$2"
  shift 2
  [ -f "$compose_file" ] || die "Missing $compose_file"
  [ -f "$env_file" ] || die "Missing $env_file"
  (cd "$SUBBOOST_HOME" && docker_cmd compose --project-directory "$SUBBOOST_HOME" --env-file "$env_file" -f "$compose_file" "$@")
}

compose_files_with_image() {
  local image="$1"
  shift
  SUBBOOST_IMAGE="$image" SUBBOOST_CANDIDATE_IMAGE="$image" compose_files "$@"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

download_to_temp() {
  local url="$1"
  local output="$2"
  case "$url" in
    file://*) cp "${url#file://}" "$output" ;;
    /*) cp "$url" "$output" ;;
    http://*|https://*)
      # GitHub 偶发 504/连接失败：重试 3 次，前两次静默、最后一次输出 curl 错误到日志
      local attempt
      for attempt in 1 2 3; do
        if [ "$attempt" -lt 3 ]; then
          curl -fsSL "$url" -o "$output" 2>/dev/null && return 0
        else
          curl -fsSL "$url" -o "$output" && return 0
        fi
        sleep 2
      done
      return 1
      ;;
    *) cp "$url" "$output" ;;
  esac
}

json_get() {
  local key="$1"
  local file="$2"
  if [ ! -s "$file" ]; then return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$key" "$file" <<'PY'
import json
import sys
key, path = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
value = data.get(key, "")
print("" if value is None else str(value))
PY
    return 0
  fi
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

resolve_url() {
  local base="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  case "$value" in
    http://*|https://*|file://*|/*) printf '%s\n' "$value" ;;
    *)
      case "$base" in
        file://*) printf 'file://%s/%s\n' "$(dirname "${base#file://}")" "$value" ;;
        http://*|https://*) printf '%s/%s\n' "${base%/*}" "$value" ;;
        *) printf '%s/%s\n' "$(dirname "$base")" "$value" ;;
      esac
      ;;
  esac
}

read_env_file() {
  sudo_do cat "$ENV_FILE"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local tmp="$TMP_DIR/env"
  mkdir -p "$TMP_DIR"
  read_env_file | awk -F= -v key="$key" '$1 != key { print }' > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install_secret_file "$tmp" "$ENV_FILE"
}

write_runtime_env_value() {
  local key="$1"
  local value="$2"
  write_env_value "$key" "$value"
  export "$key=$value"
}

is_official_fixed_release_url() {
  case "$1" in
    https://github.com/SubBoost/subboost/releases/download/v[0-9]*.[0-9]*.[0-9]*/release.json) return 0 ;;
    *) return 1 ;;
  esac
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
  fi
}

set_file_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp="$TMP_DIR/env.$key"
  awk -F= -v key="$key" '$1 != key { print }' "$file" > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

atomic_install_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  stage_install_file "$source" "$destination" "$mode"
  activate_staged_file "$destination"
}

stage_install_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local staged="${destination}.candidate.$$"
  sudo_do install -m "$mode" "$source" "$staged" || return 1
  if [ "$mode" = "600" ] && ! is_root; then
    sudo_do chown "$(id -u):$(id -g)" "$staged" || return 1
  fi
}

activate_staged_file() {
  local destination="$1"
  sudo_do mv -f "${destination}.candidate.$$" "$destination"
}

install_file_from_url() {
  local url="$1"
  local destination="$2"
  local mode="$3"
  local tmp="$TMP_DIR/download"
  mkdir -p "$TMP_DIR"
  download_to_temp "$url" "$tmp"
  sudo_do install -m "$mode" "$tmp" "$destination"
}

create_verified_dump() {
  local output="$1"
  local partial="${output}.partial"
  local -a dump_status verify_status
  prepare_private_directory "$(dirname "$output")"
  sudo_do install -m 600 /dev/null "$partial"
  set +e
  compose exec -T db pg_dump -Fc -U "${POSTGRES_USER:-subboost}" -d "${POSTGRES_DB:-subboost}" | sudo_do tee "$partial" >/dev/null
  dump_status=("${PIPESTATUS[@]}")
  set -e
  if (( dump_status[0] != 0 || dump_status[1] != 0 )) || [ ! -s "$partial" ]; then
    sudo_do rm -f -- "$partial"
    say "Backup failed: pg_dump=${dump_status[0]} write=${dump_status[1]}"
    return 1
  fi
  set +e
  sudo_do cat "$partial" | (
    compose exec -T db pg_restore --list >/dev/null
    restore_status=$?
    # pg_restore --list may finish before consuming the complete archive.
    cat >/dev/null || exit 1
    exit "$restore_status"
  )
  verify_status=("${PIPESTATUS[@]}")
  set -e
  if (( verify_status[0] != 0 || verify_status[1] != 0 )); then
    sudo_do rm -f -- "$partial"
    say "Backup verification failed: read=${verify_status[0]} verify=${verify_status[1]}"
    return 1
  fi
  sudo_do mv "$partial" "$output"
}

port_number() {
  local value="$1"
  case "$value" in
    *:*) value="${value##*:}" ;;
  esac
  value="${value#[}"
  value="${value%]}"
  printf '%s\n' "$value"
}

service_container_id() {
  compose ps -q "$1" 2>/dev/null | head -n 1 || true
}

container_state() {
  local container_id="$1"
  [ -n "$container_id" ] || return 0
  docker_cmd inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true
}

container_health() {
  local container_id="$1"
  [ -n "$container_id" ] || return 0
  docker_cmd inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true
}

service_status_text() {
  local service="$1"
  local container_id state health
  container_id="$(service_container_id "$service")"
  if [ -z "$container_id" ]; then
    printf '未创建\n'
    return 0
  fi

  state="$(container_state "$container_id")"
  case "$state" in
    running)
      if [ "$service" = "db" ]; then
        health="$(container_health "$container_id")"
        case "$health" in
          healthy) printf '运行中，健康\n' ;;
          starting) printf '运行中，健康检查中\n' ;;
          unhealthy) printf '运行中，未健康\n' ;;
          *) printf '运行中\n' ;;
        esac
      else
        printf '运行中\n'
      fi
      ;;
    exited) printf '已停止\n' ;;
    restarting) printf '正在重启\n' ;;
    dead) printf '异常停止\n' ;;
    *) printf '%s\n' "${state:-未知}" ;;
  esac
}

health_status_text() {
  health_status_label "$(health_status_code)"
}

health_status_code() {
  local port base live_ok
  port="$(port_number "${SUBBOOST_PORT:-3000}")"
  base="http://127.0.0.1:$port"
  if ! command -v curl >/dev/null 2>&1; then
    printf 'curl-missing\n'
  else
    if curl -fsS "$base/api/health/live" >/dev/null 2>&1; then
      live_ok=1
    else
      live_ok=0
    fi

    if [ "$live_ok" = "1" ] && curl -fsS "$base/api/health/ready" >/dev/null 2>&1; then
      printf 'ok\n'
    elif [ "$live_ok" = "1" ]; then
      printf 'not-ready\n'
    else
      printf 'unhealthy\n'
    fi
  fi
}

health_status_label() {
  case "$1" in
    ok) printf '正常\n' ;;
    not-ready) printf '应用已启动，数据库未就绪\n' ;;
    curl-missing) printf '缺少 curl\n' ;;
    *) printf '异常\n' ;;
  esac
}

wait_for_health() {
  # Default max wait is about 30 seconds: 15 attempts with a 2-second interval.
  local attempts="${SUBBOOST_DOCTOR_HEALTH_ATTEMPTS:-15}"
  local interval="${SUBBOOST_DOCTOR_HEALTH_INTERVAL_SECONDS:-2}"
  local index status
  for index in $(seq 1 "$attempts"); do
    status="$(health_status_code)"
    if [ "$status" = "ok" ]; then
      return 0
    fi
    if [ "$index" != "$attempts" ]; then
      sleep "$interval"
    fi
  done
  return 1
}

doctor_health_failure_message() {
  local status="$1"
  case "$status" in
    not-ready) printf 'Health check failed: database is not ready.' ;;
    curl-missing) printf 'Health check failed: curl command is missing.' ;;
    *) printf 'Health check failed: app is not responding.' ;;
  esac
}

status_cmd() {
  load_env
  say "SubBoost 状态"
  say "访问地址: ${APP_URL:-未配置}"
  say "安装目录: $SUBBOOST_HOME"
  say ""
  say "服务状态:"
  say "应用: $(service_status_text app)"
  say "数据库: $(service_status_text db)"
  say "定时任务: $(service_status_text cron)"
  say ""
  say "健康检查: $(health_status_text)"
  say "备份目录: $BACKUP_DIR"
  say ""
  say "常用命令: subboost logs / subboost backup / subboost update / subboost restart / subboost doctor"
}

json_escape() {
  local input="$1"
  input=${input//\\/\\\\}
  input=${input//\"/\\\"}
  input=${input//$'\n'/\\n}
  input=${input//$'\r'/}
  input=${input//$'\t'/\\t}
  printf '%s' "$input"
}

# Write the website-visible update status atomically. Relies on the
# OPS_REQUESTED_* / OPS_STARTED_AT globals set by run_update_request_locked.
ops_write_status() {
  local state="$1" message="${2:-}"
  local finished_at="" log_tail=""
  if [ "$state" = "succeeded" ] || [ "$state" = "failed" ]; then
    finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  if [ -f "$OPS_UPDATE_LOG" ]; then
    log_tail="$(tail -n 15 "$OPS_UPDATE_LOG" 2>/dev/null || true)"
  fi
  local tmp_status="$OPS_STATUS_FILE.tmp.$$"
  {
    printf '{\n'
    printf '  "state": "%s",\n' "$(json_escape "$state")"
    printf '  "requestedAt": "%s",\n' "$(json_escape "${OPS_REQUESTED_AT:-}")"
    printf '  "requestedBy": "%s",\n' "$(json_escape "${OPS_REQUESTED_BY:-}")"
    printf '  "targetVersion": "%s",\n' "$(json_escape "${OPS_TARGET_VERSION:-}")"
    printf '  "startedAt": "%s",\n' "$(json_escape "${OPS_STARTED_AT:-}")"
    printf '  "finishedAt": "%s",\n' "$(json_escape "$finished_at")"
    printf '  "message": "%s",\n' "$(json_escape "$message")"
    printf '  "logTail": "%s"\n' "$(json_escape "$log_tail")"
    printf '}\n'
  } > "$tmp_status"
  sudo_do mv "$tmp_status" "$OPS_STATUS_FILE"
  # 状态文件由网站（node 用户，uid OPS_APP_UID）与宿主机 updater（root）轮流写：
  # root 写完后须让网站用户仍可覆盖，否则下次网页端更新在记录请求时就写失败。
  # chown 不可用时退到 0666，与 ensure_update_watcher 处理 OPS_DIR 的方式一致。
  sudo_do chown "$OPS_APP_UID:$OPS_APP_UID" "$OPS_STATUS_FILE" 2>/dev/null \
    || sudo_do chmod 0666 "$OPS_STATUS_FILE" || true
}

# Write the website-visible pre-pull status atomically. Same ownership rule
# as ops_write_status: the site (uid OPS_APP_UID) and the host updater (root)
# take turns writing it.
ops_write_prepull_status() {
  local state="$1" message="${2:-}" target_version="${3:-}" image_tag="${4:-}"
  local tmp_status="$OPS_PREPULL_STATUS_FILE.tmp.$$"
  {
    printf '{\n'
    printf '  "state": "%s",\n' "$(json_escape "$state")"
    printf '  "targetVersion": "%s",\n' "$(json_escape "$target_version")"
    printf '  "imageTag": "%s",\n' "$(json_escape "$image_tag")"
    printf '  "message": "%s",\n' "$(json_escape "$message")"
    printf '  "updatedAt": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '}\n'
  } > "$tmp_status"
  sudo_do mv "$tmp_status" "$OPS_PREPULL_STATUS_FILE"
  sudo_do chown "$OPS_APP_UID:$OPS_APP_UID" "$OPS_PREPULL_STATUS_FILE" 2>/dev/null \
    || sudo_do chmod 0666 "$OPS_PREPULL_STATUS_FILE" || true
}

# Append one entry to the update history (newest first, capped). Best effort:
# a history failure must never fail an update.
ops_append_history() {
  local from_version="$1" target_version="$2" state="$3" started_at="$4" finished_at="$5" message="$6"
  local max_entries="${UPDATE_HISTORY_MAX_ENTRIES:-20}"
  local tmp_history="$OPS_HISTORY_FILE.tmp.$$"
  if command -v python3 >/dev/null 2>&1; then
    UPDATE_HISTORY_FILE="$OPS_HISTORY_FILE" UPDATE_HISTORY_MAX="$max_entries" \
    UPDATE_HISTORY_ENTRY_FROM="$from_version" UPDATE_HISTORY_ENTRY_TARGET="$target_version" \
    UPDATE_HISTORY_ENTRY_STATE="$state" UPDATE_HISTORY_ENTRY_STARTED="$started_at" \
    UPDATE_HISTORY_ENTRY_FINISHED="$finished_at" UPDATE_HISTORY_ENTRY_MESSAGE="$message" \
    python3 - <<'PY' > "$tmp_history" 2>/dev/null || return 0
import json
import os
path = os.environ["UPDATE_HISTORY_FILE"]
try:
    with open(path, "r", encoding="utf-8") as handle:
        history = json.load(handle)
except Exception:
    history = []
if not isinstance(history, list):
    history = []
entry = {
    "fromVersion": os.environ.get("UPDATE_HISTORY_ENTRY_FROM") or None,
    "targetVersion": os.environ.get("UPDATE_HISTORY_ENTRY_TARGET") or None,
    "state": os.environ.get("UPDATE_HISTORY_ENTRY_STATE") or "",
    "startedAt": os.environ.get("UPDATE_HISTORY_ENTRY_STARTED") or None,
    "finishedAt": os.environ.get("UPDATE_HISTORY_ENTRY_FINISHED") or None,
    "message": os.environ.get("UPDATE_HISTORY_ENTRY_MESSAGE") or None,
}
history.insert(0, entry)
print(json.dumps(history[: int(os.environ.get("UPDATE_HISTORY_MAX", "20"))], ensure_ascii=False))
PY
  else
    {
      printf '[{"fromVersion": "%s", "targetVersion": "%s", "state": "%s", "startedAt": "%s", "finishedAt": "%s", "message": "%s"}]\n' \
        "$(json_escape "$from_version")" "$(json_escape "$target_version")" "$(json_escape "$state")" \
        "$(json_escape "$started_at")" "$(json_escape "$finished_at")" "$(json_escape "$message")"
    } > "$tmp_history" 2>/dev/null || return 0
  fi
  sudo_do mv "$tmp_history" "$OPS_HISTORY_FILE" 2>/dev/null || return 0
  sudo_do chown "$OPS_APP_UID:$OPS_APP_UID" "$OPS_HISTORY_FILE" 2>/dev/null \
    || sudo_do chmod 0666 "$OPS_HISTORY_FILE" || true
}

# Remove local images of the same repository except the current one and the
# previous one (kept for rollback). Best effort: never fail an update.
prune_old_images() {
  local current_ref="$1" keep_id="$2"
  local repo="${current_ref%:*}"
  local current_id=""
  current_id="$(docker_cmd inspect -f '{{.Id}}' "$current_ref" 2>/dev/null || true)"
  [ -n "$repo" ] || return 0
  [ -n "$current_id" ] || return 0
  local line image_id image_ref
  local -a in_use_refs
  mapfile -t in_use_refs < <(docker_cmd ps -a --format '{{.Image}}' 2>/dev/null || true)
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    image_id="${line%% *}"
    image_ref="${line#* }"
    [ -n "$image_id" ] || continue
    if [ "$image_id" = "$current_id" ] || [ "$image_id" = "$keep_id" ]; then continue; fi
    local ref_in_use=0 ref
    for ref in "${in_use_refs[@]}"; do
      if [ "$ref" = "$image_ref" ] || [ "$ref" = "$image_id" ]; then ref_in_use=1; break; fi
    done
    if [ "$ref_in_use" = "1" ]; then continue; fi
    if docker_cmd image rm "$image_id" >/dev/null 2>&1; then
      say "Pruned old image: $image_ref"
    fi
  done < <(docker_cmd images --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null || true)
  return 0
}

ensure_update_watcher() {
  command -v systemctl >/dev/null 2>&1 || return 0
  sudo_do mkdir -p "$OPS_DIR" || return 0
  sudo_do chown "$OPS_APP_UID:$OPS_APP_UID" "$OPS_DIR" 2>/dev/null || sudo_do chmod 0777 "$OPS_DIR" || true
  sudo_do rm -f "$OPS_REQUEST_FILE" || true
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"installed":true,"installedAt":"%s"}\n' "$now" | sudo_do tee "$OPS_WATCHER_FILE" >/dev/null || return 0
  sudo_do tee "$UPDATE_WATCHER_PATH_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=SubBoost update request watcher
[Path]
PathModified=$OPS_REQUEST_FILE
[Install]
WantedBy=multi-user.target
EOF
  sudo_do tee "$UPDATE_WATCHER_SERVICE_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=Run SubBoost update on request
[Service]
Type=oneshot
ExecStart=/usr/local/bin/subboost run-update-request
[Install]
WantedBy=multi-user.target
EOF
  sudo_do systemctl daemon-reload || return 0
  sudo_do systemctl enable --now subboost-update-watcher.path || return 0
  say "Update watcher installed: website updates enabled."
}

ensure_prepull_watcher() {
  command -v systemctl >/dev/null 2>&1 || return 0
  sudo_do mkdir -p "$OPS_DIR" || return 0
  sudo_do chown "$OPS_APP_UID:$OPS_APP_UID" "$OPS_DIR" 2>/dev/null || sudo_do chmod 0777 "$OPS_DIR" || true
  sudo_do rm -f "$OPS_PREPULL_REQUEST_FILE" || true
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"installed":true,"installedAt":"%s"}\n' "$now" | sudo_do tee "$OPS_PREPULL_WATCHER_FILE" >/dev/null || return 0
  sudo_do tee "$PREPULL_WATCHER_PATH_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=SubBoost pre-pull request watcher
[Path]
PathModified=$OPS_PREPULL_REQUEST_FILE
[Install]
WantedBy=multi-user.target
EOF
  sudo_do tee "$PREPULL_WATCHER_SERVICE_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=Pre-pull SubBoost image on request
[Service]
Type=oneshot
ExecStart=/usr/local/bin/subboost run-prepull-request
[Install]
WantedBy=multi-user.target
EOF
  sudo_do systemctl daemon-reload || return 0
  sudo_do systemctl enable --now subboost-prepull-watcher.path || return 0
  say "Pre-pull watcher installed: background image pre-pulls enabled."
}

ensure_auto_update_timer() {
  command -v systemctl >/dev/null 2>&1 || return 0
  sudo_do tee "$AUTO_UPDATE_TIMER_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=Weekly SubBoost update check
[Timer]
OnCalendar=Sun 03:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  sudo_do tee "$AUTO_UPDATE_SERVICE_UNIT" >/dev/null <<EOF || return 0
[Unit]
Description=Check for a SubBoost update (and pre-pull or apply it)
[Service]
Type=oneshot
ExecStart=/usr/local/bin/subboost auto-update-check
[Install]
WantedBy=multi-user.target
EOF
  sudo_do systemctl daemon-reload || return 0
  sudo_do systemctl enable --now subboost-auto-update.timer || return 0
  say "Auto-update timer installed: weekly check on Sundays at 03:00."
}

# (Re)install all website-driven update services. Called on fresh installs
# and at the end of every successful update, so existing installs pick the
# new units up on the next update.
ensure_update_services() {
  ensure_update_watcher
  ensure_prepull_watcher
  ensure_auto_update_timer
}

run_update_request_locked() {
  OPS_REQUESTED_AT="$(json_get requestedAt "$OPS_REQUEST_FILE" || true)"
  OPS_REQUESTED_BY="$(json_get requestedBy "$OPS_REQUEST_FILE" || true)"
  OPS_TARGET_VERSION="$(json_get targetVersion "$OPS_REQUEST_FILE" || true)"
  sudo_do rm -f "$OPS_REQUEST_FILE" || true
  OPS_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ops_write_status "running" "正在更新……"
  local from_image="" from_version="" finished_at=""
  from_image="$(grep '^SUBBOOST_IMAGE=' "$ENV_FILE" 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  from_version="${from_image##*:}"
  if [ "$from_version" = "$from_image" ]; then from_version=""; else from_version="${from_version#v}"; fi
  : >> "$OPS_UPDATE_LOG" 2>/dev/null || sudo_do touch "$OPS_UPDATE_LOG" || true
  local update_code=0
  if ( update_cmd ) >>"$OPS_UPDATE_LOG" 2>&1; then
    update_code=0
  else
    update_code=$?
  fi
  tail -n 200 "$OPS_UPDATE_LOG" > "$OPS_UPDATE_LOG.tmp.$$" 2>/dev/null && sudo_do mv "$OPS_UPDATE_LOG.tmp.$$" "$OPS_UPDATE_LOG" || true
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$update_code" = "0" ]; then
    ops_write_status "succeeded" "更新完成"
    ops_append_history "$from_version" "$OPS_TARGET_VERSION" "succeeded" "$OPS_STARTED_AT" "$finished_at" "更新完成" || true
  else
    ops_write_status "failed" "更新失败（exit $update_code），请查看服务器 $OPS_UPDATE_LOG"
    ops_append_history "$from_version" "$OPS_TARGET_VERSION" "failed" "$OPS_STARTED_AT" "$finished_at" "更新失败（exit $update_code）" || true
  fi
  return "$update_code"
}

run_update_request() {
  [ -f "$OPS_REQUEST_FILE" ] || return 0
  sudo_do mkdir -p "$OPS_DIR" || return 0
  local lock_dir="$OPS_DIR/.update-lock"
  if [ -d "$lock_dir" ]; then
    if [ -n "$(find "$lock_dir" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      sudo_do rmdir "$lock_dir" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  sudo_do mkdir "$lock_dir" 2>/dev/null || return 0
  local result=0
  (
    trap 'sudo_do rmdir "$lock_dir" 2>/dev/null || true' EXIT
    run_update_request_locked
  ) || result=$?
  sudo_do rmdir "$lock_dir" 2>/dev/null || true
  return "$result"
}

# The pull step of an update, run early: download the manifest and the
# candidate Compose, then pull the target image so a later update only swaps.
# Runs in a subshell (via run_prepull_request_locked), so die() exits the
# subshell and the wrapper can record the failure.
prepull_cmd() {
  load_env
  local release_url="${SUBBOOST_RELEASE_URL:-}"
  local release_file="$TMP_DIR/release.json"
  local candidate_env="$TMP_DIR/candidate.env"
  local candidate_compose="$TMP_DIR/candidate-compose.yml"
  local image="" compose_url=""
  mkdir -p "$TMP_DIR"
  [ -n "$release_url" ] || die "No release URL configured; cannot pre-pull."
  download_to_temp "$release_url" "$release_file" || die "Release manifest unavailable; pre-pull aborted."
  image="$(json_get image "$release_file" || true)"
  compose_url="$(resolve_url "$release_url" "$(json_get composeUrl "$release_file" || true)")"
  [ -n "$image" ] && [ -n "$compose_url" ] || die "Release manifest is missing image or composeUrl."
  download_to_temp "$compose_url" "$candidate_compose" || die "Candidate Compose unavailable; pre-pull aborted."
  read_env_file > "$candidate_env"
  set_file_env_value "$candidate_env" SUBBOOST_IMAGE "$image"
  set_file_env_value "$candidate_env" SUBBOOST_CANDIDATE_IMAGE "$image"
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" config >/dev/null || die "Candidate Compose is invalid."
  say "Pre-pulling image $image ..."
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" pull || die "Image pre-pull failed."
  # TMP_DIR is removed by the EXIT trap when the subshell exits, so the
  # resolved image has to travel back through OPS_DIR instead.
  printf '%s\n' "$image" > "$OPS_DIR/.prepull-image"
}

run_prepull_request_locked() {
  local target_version=""
  target_version="$(json_get targetVersion "$OPS_PREPULL_REQUEST_FILE" || true)"
  sudo_do rm -f "$OPS_PREPULL_REQUEST_FILE" || true
  ops_write_prepull_status "pulling" "正在后台拉取镜像……" "$target_version" ""
  : >> "$OPS_UPDATE_LOG" 2>/dev/null || sudo_do touch "$OPS_UPDATE_LOG" || true
  local prepull_code=0 image=""
  if ( prepull_cmd ) >>"$OPS_UPDATE_LOG" 2>&1; then
    prepull_code=0
  else
    prepull_code=$?
  fi
  image="$(cat "$OPS_DIR/.prepull-image" 2>/dev/null || true)"
  sudo_do rm -f "$OPS_DIR/.prepull-image" || true
  if [ "$prepull_code" = "0" ]; then
    ops_write_prepull_status "ready" "镜像已就绪，点立即更新时无需再下载" "$target_version" "$image"
  else
    ops_write_prepull_status "failed" "后台拉取失败（exit $prepull_code），请查看服务器 $OPS_UPDATE_LOG" "$target_version" "$image"
  fi
  return "$prepull_code"
}

run_prepull_request() {
  [ -f "$OPS_PREPULL_REQUEST_FILE" ] || return 0
  sudo_do mkdir -p "$OPS_DIR" || return 0
  local lock_dir="$OPS_DIR/.prepull-lock"
  if [ -d "$lock_dir" ]; then
    if [ -n "$(find "$lock_dir" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      sudo_do rmdir "$lock_dir" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  # 更新正在跑时不用预拉：更新本身就会拉同一份镜像。
  if [ -d "$OPS_DIR/.update-lock" ]; then return 0; fi
  sudo_do mkdir "$lock_dir" 2>/dev/null || return 0
  local result=0
  (
    trap 'sudo_do rmdir "$lock_dir" 2>/dev/null || true' EXIT
    run_prepull_request_locked
  ) || result=$?
  sudo_do rmdir "$lock_dir" 2>/dev/null || true
  return "$result"
}

# Weekly timer entry point: check for a newer release. With auto-update on,
# request the update; otherwise only request a background pre-pull so the
# image is ready when the user clicks update. Always exits 0: a background
# check must never report failure for a skipped or unavailable manifest.
auto_update_check() {
  [ -f "$ENV_FILE" ] || return 0
  load_env
  local release_url="${SUBBOOST_RELEASE_URL:-}"
  local auto_enabled=""
  auto_enabled="$(json_get enabled "$OPS_AUTO_UPDATE_FILE" 2>/dev/null || true)"
  local release_file="$TMP_DIR/release.json"
  local latest_version="" latest_image="" current_image="${SUBBOOST_IMAGE:-}" current_version=""
  local status_state=""
  mkdir -p "$TMP_DIR"
  if [ -z "$release_url" ]; then
    say "Auto-update check skipped: no release URL configured."
    return 0
  fi
  if ! download_to_temp "$release_url" "$release_file" 2>/dev/null; then
    say "Auto-update check skipped: release manifest unavailable."
    return 0
  fi
  latest_version="$(json_get version "$release_file" || true)"
  latest_image="$(json_get image "$release_file" || true)"
  if [ -z "$latest_version" ] || [ -z "$latest_image" ]; then
    say "Auto-update check skipped: release manifest is incomplete."
    return 0
  fi
  if [ "$latest_image" = "$current_image" ]; then
    say "Auto-update check: already on the latest version ($latest_version)."
    return 0
  fi
  current_version="${current_image##*:}"
  current_version="${current_version#v}"
  latest_version="${latest_version#v}"
  if [ -n "$current_version" ] && [ "$current_version" != "$current_image" ]; then
    if [ "$(printf '%s\n%s\n' "$current_version" "$latest_version" | sort -V | tail -n 1)" = "$current_version" ]; then
      say "Auto-update check: current version ($current_version) is newer than latest ($latest_version); skipping."
      return 0
    fi
  fi
  status_state="$(json_get state "$OPS_STATUS_FILE" 2>/dev/null || true)"
  if [ "$status_state" = "requested" ] || [ "$status_state" = "running" ]; then
    say "Auto-update check: an update is already in progress; skipping."
    return 0
  fi
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$auto_enabled" in
    true|True|1)
      if [ -f "$OPS_REQUEST_FILE" ]; then
        say "Auto-update check: an update request already exists; skipping."
        return 0
      fi
      printf '{"requestedAt":"%s","requestedBy":"auto-update","targetVersion":"%s"}\n' "$now" "$(json_escape "$latest_version")" > "$OPS_REQUEST_FILE" 2>/dev/null || true
      say "Auto-update check: new version $latest_version found; update requested."
      printf '%s\n' "Auto-update check: new version $latest_version found; update requested." >> "$OPS_UPDATE_LOG" 2>/dev/null || true
      ;;
    *)
      if [ -f "$OPS_PREPULL_REQUEST_FILE" ]; then
        say "Auto-update check: a pre-pull request already exists; skipping."
        return 0
      fi
      printf '{"requestedAt":"%s","requestedBy":"auto-update","targetVersion":"%s"}\n' "$now" "$(json_escape "$latest_version")" > "$OPS_PREPULL_REQUEST_FILE" 2>/dev/null || true
      say "Auto-update check: new version $latest_version found; pre-pull requested."
      printf '%s\n' "Auto-update check: new version $latest_version found; pre-pull requested." >> "$OPS_UPDATE_LOG" 2>/dev/null || true
      ;;
  esac
  return 0
}

update_cmd() {
  load_env
  local release_url="${SUBBOOST_RELEASE_URL:-}"
  local release_file="$TMP_DIR/release.json"
  local candidate_env="$TMP_DIR/candidate.env"
  local candidate_compose="$TMP_DIR/candidate-compose.yml"
  local candidate_manager="$TMP_DIR/candidate-manager"
  local old_env="$TMP_DIR/old.env"
  local old_compose="$TMP_DIR/old-compose.yml"
  local old_manager="$TMP_DIR/old-manager"
  local rollback_dump="$BACKUP_DIR/update-rollback-$(date -u +%Y%m%dT%H%M%SZ).dump"
  local image="${SUBBOOST_IMAGE:-}" compose_url="" manager_url="" services=""
  local app_id old_image_id rollback_tag old_image_ref update_error restore_error db_ready
  local manager_present=0 old_manager_present=0
  local -a restore_status
  mkdir -p "$TMP_DIR"
  if is_official_fixed_release_url "$release_url"; then
    say "Detected old fixed release update source; switching updates to stable latest."
    release_url="$DEFAULT_STABLE_RELEASE_URL"
  fi
  if [ -n "$release_url" ]; then
    # 清单地址已配置：下载失败就是一次失败的更新，直接报错退出；
    # 不要静默退回“只重拉当前镜像”——那会让网页端显示更新完成，版本却一动没动。
    download_to_temp "$release_url" "$release_file" || die "Release manifest unavailable; update aborted."
    image="$(json_get image "$release_file" || true)"
    compose_url="$(resolve_url "$release_url" "$(json_get composeUrl "$release_file" || true)")"
    manager_url="$(resolve_url "$release_url" "$(json_get managerUrl "$release_file" || true)")"
    [ -n "$image" ] && [ -n "$compose_url" ] && [ -n "$manager_url" ] || die "Release manifest is missing image, composeUrl, or managerUrl."
    download_to_temp "$compose_url" "$candidate_compose"
    download_to_temp "$manager_url" "$candidate_manager"
    [ -s "$candidate_manager" ] && bash -n "$candidate_manager" || die "Candidate manager is invalid."
  else
    say "Release manifest unavailable; updating current image and compose only."
    cp "$COMPOSE_FILE" "$candidate_compose"
    if [ -f "${SUBBOOST_BIN:-/usr/local/bin/subboost}" ]; then
      sudo_do cp "${SUBBOOST_BIN:-/usr/local/bin/subboost}" "$candidate_manager"
      manager_present=1
    fi
  fi
  [ -n "$manager_url" ] && manager_present=1
  [ -n "$image" ] || die "SUBBOOST_IMAGE is missing."
  read_env_file > "$candidate_env"
  cp "$candidate_env" "$old_env"
  cp "$COMPOSE_FILE" "$old_compose"
  if [ -f "${SUBBOOST_BIN:-/usr/local/bin/subboost}" ]; then
    sudo_do cp "${SUBBOOST_BIN:-/usr/local/bin/subboost}" "$old_manager"
    old_manager_present=1
  fi
  set_file_env_value "$candidate_env" SUBBOOST_IMAGE "$image"
  set_file_env_value "$candidate_env" SUBBOOST_CANDIDATE_IMAGE "$image"
  set_file_env_value "$candidate_env" SUBBOOST_RELEASE_URL "$release_url"
  [ -n "$compose_url" ] && set_file_env_value "$candidate_env" SUBBOOST_COMPOSE_URL "$compose_url"
  [ -n "$manager_url" ] && set_file_env_value "$candidate_env" SUBBOOST_MANAGER_URL "$manager_url"
  if ! grep -q '^LOCAL_SETUP_TOKEN=.' "$candidate_env"; then
    set_file_env_value "$candidate_env" LOCAL_SETUP_TOKEN "$(random_hex 32)"
  fi
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" config >/dev/null
  services="$(compose_files_with_image "$image" "$candidate_env" "$candidate_compose" config --services)"
  for service in app db cron; do
    printf '%s\n' "$services" | grep -Fxq "$service" || die "Candidate Compose is missing service: $service"
  done
  say "Pulling candidate image before the maintenance window..."
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" pull

  app_id="$(service_container_id app)"
  [ -n "$app_id" ] || die "Cannot identify the current app container for rollback."
  old_image_id="$(docker_cmd inspect -f '{{.Image}}' "$app_id" 2>/dev/null || true)"
  [ -n "$old_image_id" ] || die "Cannot identify the current app image for rollback."
  old_image_ref="${SUBBOOST_IMAGE:-}"
  rollback_tag="subboost-rollback:update-$$"
  if ! stage_install_file "$candidate_env" "$ENV_FILE" 600 \
    || ! stage_install_file "$candidate_compose" "$COMPOSE_FILE" 644 \
    || { [ "$manager_present" = "1" ] && ! stage_install_file "$candidate_manager" "${SUBBOOST_BIN:-/usr/local/bin/subboost}" 755; }; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    die "Candidate metadata could not be staged safely."
  fi
  if ! docker_cmd tag "$old_image_id" "$rollback_tag"; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    die "Could not create the rollback image tag."
  fi

  say "Pausing app and cron for a stable database snapshot..."
  if ! compose stop cron app; then
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    die "Update aborted because app and cron could not be paused safely."
  fi
  if ! create_verified_dump "$rollback_dump"; then
    compose up -d app cron || true
    wait_for_health || true
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    die "Update aborted because a verified rollback dump could not be created."
  fi

  update_error=""
  compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d db || update_error="candidate database startup failed"
  if [ -z "$update_error" ]; then
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d --no-deps app || update_error="candidate app startup or migration failed"
  fi
  if [ -z "$update_error" ] && ! wait_for_health; then
    update_error="candidate health check failed"
  fi
  if [ -z "$update_error" ]; then
    activate_staged_file "$ENV_FILE" || update_error="candidate environment activation failed"
  fi
  if [ -z "$update_error" ]; then
    activate_staged_file "$COMPOSE_FILE" || update_error="candidate Compose activation failed"
  fi
  if [ -z "$update_error" ] && [ "$manager_present" = "1" ]; then
    activate_staged_file "${SUBBOOST_BIN:-/usr/local/bin/subboost}" || update_error="candidate manager activation failed"
  fi
  if [ -z "$update_error" ]; then
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" up -d --no-deps cron || update_error="candidate cron startup failed"
  fi

  if [ -n "$update_error" ]; then
    say "Candidate update failed: $update_error"
    compose_files_with_image "$image" "$candidate_env" "$candidate_compose" stop cron app >/dev/null 2>&1 || true
    docker_cmd tag "$rollback_tag" "$old_image_ref" || true
    sudo_do rm -f "${ENV_FILE}.candidate.$$" "${COMPOSE_FILE}.candidate.$$" "${SUBBOOST_BIN:-/usr/local/bin/subboost}.candidate.$$"
    restore_error=""
    atomic_install_file "$old_env" "$ENV_FILE" 600 || restore_error="old environment metadata restore failed"
    atomic_install_file "$old_compose" "$COMPOSE_FILE" 644 || restore_error="old Compose metadata restore failed"
    if [ "$old_manager_present" = "1" ]; then
      atomic_install_file "$old_manager" "${SUBBOOST_BIN:-/usr/local/bin/subboost}" 755 || restore_error="old manager metadata restore failed"
    fi
    db_ready=1
    compose_files "$old_env" "$old_compose" up -d db || { restore_error="old database container did not start"; db_ready=0; }
    if [ "$db_ready" = "1" ]; then
      set +e
      sudo_do cat "$rollback_dump" | compose_files "$old_env" "$old_compose" exec -T db pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges -U "${POSTGRES_USER:-subboost}" -d "${POSTGRES_DB:-subboost}"
      restore_status=("${PIPESTATUS[@]}")
      set -e
      if (( restore_status[0] != 0 || restore_status[1] != 0 )); then restore_error="database restore failed"; fi
    fi
    if [ -n "$restore_error" ]; then
      compose_files "$old_env" "$old_compose" stop cron app >/dev/null 2>&1 || true
      say "Automatic rollback stopped: $restore_error"
      say "Rollback dump preserved at: $rollback_dump"
      say "Keep app and cron stopped. Restore manually with pg_restore before restarting them."
      return 1
    fi
    compose_files "$old_env" "$old_compose" up -d app
    if ! wait_for_health; then
      compose_files "$old_env" "$old_compose" stop cron app >/dev/null 2>&1 || true
      say "Database and old image were restored, but the old app did not become healthy."
      say "Rollback dump preserved at: $rollback_dump"
      return 1
    fi
    compose_files "$old_env" "$old_compose" up -d --no-deps cron
    docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
    say "Previous version restored successfully."
    return 1
  fi

  docker_cmd image rm "$rollback_tag" >/dev/null 2>&1 || true
  # 成功后只留当前与上一个镜像（回滚用），其余旧镜像清掉。
  prune_old_images "$image" "$old_image_id" || true
  ensure_update_services || true
  load_env
  status_cmd
}

logs_cmd() {
  compose logs -f --tail="${SUBBOOST_LOG_TAIL:-200}" "$@"
}

backup_cmd() {
  load_env
  prepare_private_directory "$BACKUP_DIR"
  local stamp db_out env_out
  local -a sql_backups env_backups
  local i backup_retention_count
  backup_retention_count="${SUBBOOST_BACKUP_RETENTION_COUNT:-$DEFAULT_BACKUP_RETENTION_COUNT}"
  if ! [[ "$backup_retention_count" =~ ^[0-9]+$ ]] || (( backup_retention_count < 1 )); then
    die "SUBBOOST_BACKUP_RETENTION_COUNT must be a positive integer"
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  db_out="$BACKUP_DIR/subboost-$stamp.dump"
  env_out="$BACKUP_DIR/subboost-$stamp.env"
  create_verified_dump "$db_out"
  sudo_do install -m 600 "$ENV_FILE" "$env_out"

  shopt -s nullglob
  sql_backups=("$BACKUP_DIR"/subboost-*.dump)
  env_backups=("$BACKUP_DIR"/subboost-*.env)
  shopt -u nullglob

  if ((${#sql_backups[@]} > 0)); then sudo_do chmod 600 "${sql_backups[@]}"; fi
  if ((${#env_backups[@]} > 0)); then sudo_do chmod 600 "${env_backups[@]}"; fi

  for ((i = 0; i < ${#sql_backups[@]} - backup_retention_count; i++)); do
    sudo_do rm -f -- "${sql_backups[$i]}"
  done
  for ((i = 0; i < ${#env_backups[@]} - backup_retention_count; i++)); do
    sudo_do rm -f -- "${env_backups[$i]}"
  done
  say "Backup written:"
  say "  $db_out"
  say "  $env_out"
}

restart_cmd() {
  compose up -d --remove-orphans
  compose up -d --no-deps --force-recreate app
  status_cmd
}

doctor_cmd() {
  command -v docker >/dev/null 2>&1 || die "docker command is missing"
  docker_cmd compose version >/dev/null 2>&1 || die "docker compose plugin is missing"
  [ -d "$SUBBOOST_HOME" ] || die "Missing $SUBBOOST_HOME"
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
  [ -f "$COMPOSE_FILE" ] || die "Missing $COMPOSE_FILE"
  load_env
  for key in SUBBOOST_IMAGE POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL ENCRYPTION_KEY JWT_SECRET CRON_SECRET APP_URL SUBBOOST_PORT; do
    grep -q "^$key=" "$ENV_FILE" || die "Missing $key in $ENV_FILE"
  done
  compose config >/dev/null
  if ! wait_for_health; then
    local health_status
    health_status="$(health_status_code)"
    status_cmd
    die "$(doctor_health_failure_message "$health_status")"
  fi
  status_cmd
  say "Doctor: OK"
}

menu_cmd() {
  say "SubBoost"
  say "1) Status"
  say "2) Update"
  say "3) Logs"
  say "4) Backup"
  say "5) Restart"
  say "6) Doctor"
  say "0) Exit"
  local choice=""
  if [ -t 0 ]; then
    printf 'Choose: '
    IFS= read -r choice || choice=""
  fi
  case "$choice" in
    1) status_cmd ;;
    2) update_cmd ;;
    3) logs_cmd ;;
    4) backup_cmd ;;
    5) restart_cmd ;;
    6) doctor_cmd ;;
    0|"") exit 0 ;;
    *) die "Unknown menu choice: $choice" ;;
  esac
}

main() {
  local command="${1:-menu}"
  if [ "$#" -gt 0 ]; then shift; fi
  case "$command" in
    menu) menu_cmd ;;
    status) status_cmd ;;
    update) update_cmd ;;
    ensure-update-watcher) ensure_update_watcher ;;
    ensure-prepull-watcher) ensure_prepull_watcher ;;
    ensure-auto-update-timer) ensure_auto_update_timer ;;
    ensure-update-services) ensure_update_services ;;
    run-update-request) run_update_request ;;
    run-prepull-request) run_prepull_request ;;
    auto-update-check) auto_update_check ;;
    logs) logs_cmd "$@" ;;
    backup) backup_cmd ;;
    restart) restart_cmd ;;
    doctor) doctor_cmd ;;
    *) die "Unknown command: $command" ;;
  esac
}

if [ "${SUBBOOST_SCRIPT_SOURCE_ONLY:-0}" != "1" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
  DOCKER_RUNNER=""
  main "$@"
fi

#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME='botmux.service'
ASSET_NAME='botmux-linux-x64'
REPO="${BOTMUX_REPO:-David-Buxy/botmux}"
VERSION="${BOTMUX_VERSION:-}"
CGROUP_FILE="${BOTMUX_CGROUP_FILE:-/proc/$$/cgroup}"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ ! "$VERSION" =~ ^fork-v[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z][0-9A-Za-z.-]*$ ]]; then
  die 'BOTMUX_VERSION 必须是固定版本，例如 fork-v3.18.14-buxy.1；不接受 latest 或未固定版本。'
fi
if [[ ! "$REPO" =~ ^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$ ]]; then
  die 'BOTMUX_REPO 必须是 owner/repo。'
fi

if [[ -r "$CGROUP_FILE" ]] && grep -Eq '(^|/)(lark-channel-bridge[^/]*\.service|botmux\.service)(/|$)' "$CGROUP_FILE"; then
  die '检测到当前进程位于旧 bridge 或 botmux.service cgroup；请从独立 SSH 会话部署。'
fi

if [[ -n "${BOTMUX_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$BOTMUX_INSTALL_DIR"
else
  CURRENT_COMMAND="$(command -v botmux || true)"
  [[ -n "$CURRENT_COMMAND" ]] || die '找不到当前 botmux；请显式设置 BOTMUX_INSTALL_DIR。'
  if command -v readlink >/dev/null 2>&1; then
    CURRENT_COMMAND="$(readlink -f "$CURRENT_COMMAND" 2>/dev/null || printf '%s' "$CURRENT_COMMAND")"
  fi
  INSTALL_DIR="$(dirname "$CURRENT_COMMAND")"
fi

ACTIVE_BINARY="$INSTALL_DIR/botmux"
[[ -d "$INSTALL_DIR" ]] || die "安装目录不存在: $INSTALL_DIR"
[[ -f "$ACTIVE_BINARY" ]] || die "当前二进制不存在: $ACTIVE_BINARY"
command -v curl >/dev/null 2>&1 || die '缺少 curl。'
command -v systemctl >/dev/null 2>&1 || die '缺少 systemctl。'

RELEASE_URL="https://github.com/$REPO/releases/download/$VERSION"
CANDIDATE="$(mktemp "$INSTALL_DIR/.botmux-candidate.XXXXXX")"
CHECKSUM_FILE="$(mktemp "$INSTALL_DIR/.botmux-checksum.XXXXXX")"
ROLLBACK=''
SWAPPED=0

cleanup_and_maybe_rollback() {
  exit_status=$?
  trap - EXIT
  if [[ "$exit_status" -ne 0 && "$SWAPPED" -eq 1 && -n "$ROLLBACK" && -f "$ROLLBACK" ]]; then
    printf '部署失败，正在恢复旧二进制: %s\n' "$ROLLBACK" >&2
    restore_tmp="$(mktemp "$INSTALL_DIR/.botmux-restore.XXXXXX")"
    cp -p "$ROLLBACK" "$restore_tmp"
    mv -f "$restore_tmp" "$ACTIVE_BINARY"
    if ! systemctl --user restart "$SERVICE_NAME"; then
      printf 'ERROR: 旧二进制已恢复，但重新启动 %s 失败；请立即人工检查。\n' "$SERVICE_NAME" >&2
    fi
  fi
  rm -f "$CANDIDATE" "$CHECKSUM_FILE"
  exit "$exit_status"
}
trap cleanup_and_maybe_rollback EXIT

curl --fail --silent --show-error --location \
  "$RELEASE_URL/$ASSET_NAME" --output "$CANDIDATE"
curl --fail --silent --show-error --location \
  "$RELEASE_URL/$ASSET_NAME.sha256" --output "$CHECKSUM_FILE"

read -r EXPECTED_SHA _ < "$CHECKSUM_FILE" || die '无法读取 SHA-256 文件。'
if [[ ! "$EXPECTED_SHA" =~ ^[0-9A-Fa-f]{64}$ ]]; then
  die 'SHA-256 文件格式无效。'
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "$CANDIDATE" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "$CANDIDATE" | awk '{print $1}')"
else
  die '缺少 sha256sum 或 shasum。'
fi
ACTUAL_SHA="$(printf '%s' "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')"
EXPECTED_SHA="$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || die 'SHA-256 校验失败，拒绝替换旧二进制。'

chmod 0755 "$CANDIDATE"
EXPECTED_BINARY_VERSION="${VERSION#fork-v}"
REPORTED_VERSION="$("$CANDIDATE" --version 2>&1 | tr -d '\r' | sed -n '1p')"
if [[ "$REPORTED_VERSION" != "$EXPECTED_BINARY_VERSION" ]]; then
  die "版本不匹配：标签要求 ${EXPECTED_BINARY_VERSION}，二进制报告 ${REPORTED_VERSION}。"
fi

ROLLBACK="$INSTALL_DIR/botmux.rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$"
cp -p "$ACTIVE_BINARY" "$ROLLBACK"
printf '已保留回滚二进制: %s\n' "$ROLLBACK"

mv -f "$CANDIDATE" "$ACTIVE_BINARY"
SWAPPED=1

systemctl --user restart "$SERVICE_NAME" || die "systemd 启动 $SERVICE_NAME 失败。"
systemctl --user is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME 未保持 active。"

if ! HEALTH_OUTPUT="$("$ACTIVE_BINARY" status 2>&1)"; then
  die 'botmux status 执行失败。'
fi
if ! grep -Eq 'supervisor.*(在线|online)' <<< "$HEALTH_OUTPUT"; then
  die '健康检查未发现在线 supervisor。'
fi
if ! grep -Eq '(^|[[:space:]])online([[:space:]]|$)' <<< "$HEALTH_OUTPUT"; then
  die '健康检查未发现在线 bot。'
fi

SWAPPED=0
printf '部署成功: %s (%s)\n' "$ACTIVE_BINARY" "$REPORTED_VERSION"

#!/usr/bin/env bash
# Unified multi-agent installer for agent-boost
# Supports: zcode, claude, codex, opencode, deepseek, workbuddy, cursor, windsurf, cline, aider, generic
set -euo pipefail

TARGET="zcode"
LANG_OPT="auto"
DRY_RUN=false
DEST=""
VERSION="$(cat "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/VERSION" 2>/dev/null || echo "0.5.0")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --lang)
      LANG_OPT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --dest)
      DEST="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--target zcode|claude|codex|opencode|deepseek|workbuddy|cursor|windsurf|cline|aider|generic] [--lang auto|zh|en] [--dry-run] [--dest <path>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$LANG_OPT" == "auto" ]]; then
  SYS_LOCALE="${LC_ALL:-${LANG:-en}}"
  if [[ "$SYS_LOCALE" == zh* || "$SYS_LOCALE" == *CN* || "$SYS_LOCALE" == *TW* || "$SYS_LOCALE" == *HK* ]]; then
    LANG_OPT="zh"
  else
    LANG_OPT="en"
  fi
fi

if [[ "$LANG_OPT" != "zh" && "$LANG_OPT" != "en" ]]; then
  echo "Invalid --lang '$LANG_OPT'. Expected 'auto', 'zh', or 'en'." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_DIR="$HOME/.local/share/agent-boost"
MANIFEST_FILE="$MANIFEST_DIR/install-manifest-${TARGET}.json"
LEGACY_MANIFEST_FILE="$MANIFEST_DIR/install-manifest.json"

case "$TARGET" in
  zcode)
    BASE_DEST="${DEST:-$HOME/.zcode}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  claude|claude-code)
    TARGET="claude"
    BASE_DEST="${DEST:-$HOME/.claude}"
    WORKFLOW_DEST="$BASE_DEST/commands"
    SKILL_DEST="$BASE_DEST/skills/boost"
    MANIFEST_FILE="$MANIFEST_DIR/install-manifest-claude.json"
    ;;
  codex)
    BASE_DEST="${DEST:-$HOME/.codex}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  opencode)
    BASE_DEST="${DEST:-$HOME/.opencode}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  deepseek)
    BASE_DEST="${DEST:-$HOME/.deepseek}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  workbuddy)
    BASE_DEST="${DEST:-$HOME/.workbuddy}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  cursor)
    BASE_DEST="${DEST:-$HOME/.cursor}"
    WORKFLOW_DEST="$BASE_DEST/rules"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  windsurf)
    BASE_DEST="${DEST:-$HOME/.windsurf}"
    WORKFLOW_DEST="$BASE_DEST/rules"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  cline|aider|generic)
    BASE_DEST="${DEST:-$HOME/.agent-boost}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/boost"
    ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    echo "Supported targets: zcode, claude, codex, opencode, deepseek, workbuddy, cursor, windsurf, cline, aider, generic" >&2
    exit 1
    ;;
esac

echo "Target platform:      $TARGET (lang: $LANG_OPT)"
echo "Workflow destination: $WORKFLOW_DEST"
echo "Skill destination:    $SKILL_DEST"

if [[ "$DRY_RUN" == true ]]; then
  echo "[Dry-Run] Target: $TARGET (lang: $LANG_OPT)"
  echo "[Dry-Run] Would copy $SCRIPT_DIR/skills/boost/SKILL.md -> $SKILL_DEST/SKILL.md"
  echo "[Dry-Run] Would copy $SCRIPT_DIR/protocol/boost.md -> $SKILL_DEST/protocol/boost.md"
  echo "[Dry-Run] Would copy $SCRIPT_DIR/roles/*.${LANG_OPT}.md -> $SKILL_DEST/roles/"
  echo "[Dry-Run] Would install workflow/adapter into $WORKFLOW_DEST"
  exit 0
fi

TIMESTAMP="$(date +%Y%m%d%H%M%S)_$$"
mkdir -p "$WORKFLOW_DEST" "$SKILL_DEST/protocol" "$SKILL_DEST/roles"

INSTALLED_FILES=()

backup_and_copy() {
  local src="$1"
  local dst="$2"
  if [[ -f "$dst" ]] && ! cmp -s "$src" "$dst"; then
    cp "$dst" "${dst}.bak-${TIMESTAMP}"
  fi
  cp "$src" "$dst"
  INSTALLED_FILES+=("$dst")
}

# 1. Backup and copy skill, protocol, and language-specific role prompts into SKILL_DEST
backup_and_copy "$SCRIPT_DIR/skills/boost/SKILL.md" "$SKILL_DEST/SKILL.md"
backup_and_copy "$SCRIPT_DIR/protocol/boost.md" "$SKILL_DEST/protocol/boost.md"
for role_file in "$SCRIPT_DIR"/roles/*."${LANG_OPT}".md; do
  if [[ -f "$role_file" ]]; then
    role_base="$(basename "$role_file")"
    backup_and_copy "$role_file" "$SKILL_DEST/roles/$role_base"
  fi
done
echo "Installed skill, protocol, and ${LANG_OPT} role prompts to $SKILL_DEST"

# 2. Install target workflow/adapter
if [[ "$TARGET" == "zcode" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/zcode/boost.dwf.ts" "$WORKFLOW_DEST/boost.dwf.ts"
  echo "Installed ZCode workflow to $WORKFLOW_DEST/boost.dwf.ts"
elif [[ "$TARGET" == "claude" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/claude-code/boost.md" "$WORKFLOW_DEST/boost.md"
  echo "Installed Claude Code command protocol to $WORKFLOW_DEST/boost.md"
elif [[ "$TARGET" == "opencode" ]]; then
  mkdir -p "$WORKFLOW_DEST/roles"
  for role_file in "$SCRIPT_DIR"/roles/*."${LANG_OPT}".md; do
    if [[ -f "$role_file" ]]; then
      role_base="$(basename "$role_file")"
      backup_and_copy "$role_file" "$WORKFLOW_DEST/roles/$role_base"
    fi
  done
  if [[ -f "$WORKFLOW_DEST/agents.json" ]]; then
    cp "$WORKFLOW_DEST/agents.json" "$WORKFLOW_DEST/agents.json.bak-${TIMESTAMP}"
  fi
  sed "s/\.en\.md/.${LANG_OPT}.md/g" "$SCRIPT_DIR/adapters/opencode/agents.json" > "$WORKFLOW_DEST/agents.json"
  INSTALLED_FILES+=("$WORKFLOW_DEST/agents.json")
  echo "Installed OpenCode agents configuration (lang: $LANG_OPT) and role prompts to $WORKFLOW_DEST"
elif [[ "$TARGET" == "codex" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/codex/protocol.md" "$WORKFLOW_DEST/protocol.md"
  echo "Installed Codex protocol to $WORKFLOW_DEST/protocol.md"
elif [[ "$TARGET" == "deepseek" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/deepseek/boost.md" "$WORKFLOW_DEST/boost.md"
  echo "Installed DeepSeek protocol to $WORKFLOW_DEST/boost.md"
elif [[ "$TARGET" == "workbuddy" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/workbuddy/boost.md" "$WORKFLOW_DEST/boost.md"
  echo "Installed WorkBuddy protocol to $WORKFLOW_DEST/boost.md"
else
  backup_and_copy "$SCRIPT_DIR/adapters/generic/boost.md" "$WORKFLOW_DEST/boost.md"
  echo "Installed generic protocol ($TARGET) to $WORKFLOW_DEST/boost.md"
fi

# 3. Record per-target manifest (and update legacy manifest for backward compatibility)
mkdir -p "$MANIFEST_DIR"
cat <<EOF > "$MANIFEST_FILE"
{
  "version": "$VERSION",
  "target": "$TARGET",
  "lang": "$LANG_OPT",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "files": $(printf '%s\n' "${INSTALLED_FILES[@]}" | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'),
  "backup_timestamp": "$TIMESTAMP"
}
EOF
cp "$MANIFEST_FILE" "$LEGACY_MANIFEST_FILE"

echo "Installation complete. Manifest saved to $MANIFEST_FILE."

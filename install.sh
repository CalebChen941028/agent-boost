#!/usr/bin/env bash
# Unified multi-agent installer for agent-boost
# Supports: zcode, claude, codex, opencode, deepseek, workbuddy, cursor, windsurf, cline, aider, generic
set -euo pipefail

TARGET="zcode"
SKILL_NAME="${SKILL_NAME:-boost-harness}"
LANG_OPT="auto"
DRY_RUN=false
FORCE=false
DEST=""
VERSION="$(cat "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/VERSION" 2>/dev/null || echo "0.6.3")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --name)
      SKILL_NAME="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
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
      echo "Usage: $0 [--target all|zcode|claude|codex|antigravity|agents|deepseek|opencode|workbuddy|cursor|windsurf|cline|aider|generic] [--lang auto|zh|en] [--name <skill-name>] [--force] [--dry-run] [--dest <path>]"
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

if [[ ! "$SKILL_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Invalid --name '$SKILL_NAME'. Use lowercase letters, digits and hyphens." >&2
  exit 1
fi

if [[ "$LANG_OPT" != "zh" && "$LANG_OPT" != "en" ]]; then
  echo "Invalid --lang '$LANG_OPT'. Expected 'auto', 'zh', or 'en'." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_DIR="$HOME/.local/share/agent-boost"
MANIFEST_FILE="$MANIFEST_DIR/install-manifest-${TARGET}.json"
LEGACY_MANIFEST_FILE="$MANIFEST_DIR/install-manifest.json"

if [[ "$TARGET" == "all" ]]; then
  DETECTED_TARGETS=()
  [[ -d "$HOME/.zcode" ]] && DETECTED_TARGETS+=("zcode")
  [[ -d "$HOME/.claude" ]] && DETECTED_TARGETS+=("claude")
  [[ -d "$HOME/.codex" ]] && DETECTED_TARGETS+=("codex")
  [[ -d "$HOME/.dsh" || -d "$HOME/.deepseek" ]] && DETECTED_TARGETS+=("deepseek")
  [[ -d "$HOME/.agents" ]] && DETECTED_TARGETS+=("agents")
  [[ -d "$HOME/.gemini" ]] && DETECTED_TARGETS+=("antigravity")
  [[ -d "$HOME/.opencode" ]] && DETECTED_TARGETS+=("opencode")
  [[ -d "$HOME/.workbuddy" ]] && DETECTED_TARGETS+=("workbuddy")
  [[ -d "$HOME/.cursor" ]] && DETECTED_TARGETS+=("cursor")
  [[ -d "$HOME/.windsurf" ]] && DETECTED_TARGETS+=("windsurf")

  if [[ ${#DETECTED_TARGETS[@]} -eq 0 ]]; then
    DETECTED_TARGETS=("zcode" "claude" "codex" "agents")
  fi

  echo "==> Multi-Agent Batch Installation: Found ${#DETECTED_TARGETS[@]} target(s): ${DETECTED_TARGETS[*]}"
  for t in "${DETECTED_TARGETS[@]}"; do
    echo ""
    echo "--- Installing for target: $t ---"
    "$0" --target "$t" --lang "$LANG_OPT" $([[ "$DRY_RUN" == true ]] && echo "--dry-run")
  done
  echo ""
  echo "All ${#DETECTED_TARGETS[@]} targets processed successfully."
  exit 0
fi

case "$TARGET" in
  zcode)
    BASE_DEST="${DEST:-$HOME/.zcode}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  claude|claude-code)
    TARGET="claude"
    BASE_DEST="${DEST:-$HOME/.claude}"
    WORKFLOW_DEST="$BASE_DEST/commands"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    MANIFEST_FILE="$MANIFEST_DIR/install-manifest-claude.json"
    ;;
  codex)
    BASE_DEST="${DEST:-$HOME/.codex}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  antigravity|gemini)
    TARGET="antigravity"
    # Antigravity discovers global skills under ~/.gemini/config/skills;
    # ~/.gemini/antigravity/skills is not a discovery root.
    BASE_DEST="${DEST:-$HOME/.gemini/config}"
    WORKFLOW_DEST="$BASE_DEST/skills/$SKILL_NAME"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    MANIFEST_FILE="$MANIFEST_DIR/install-manifest-antigravity.json"
    ;;
  agents)
    TARGET="agents"
    BASE_DEST="${DEST:-$HOME/.agents}"
    WORKFLOW_DEST="$BASE_DEST/skills/$SKILL_NAME"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    MANIFEST_FILE="$MANIFEST_DIR/install-manifest-agents.json"
    ;;
  opencode)
    BASE_DEST="${DEST:-$HOME/.opencode}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  deepseek|dsh)
    TARGET="deepseek"
    if [[ -n "$DEST" ]]; then
      BASE_DEST="$DEST"
    elif [[ -d "$HOME/.dsh" ]]; then
      BASE_DEST="$HOME/.dsh"
    else
      BASE_DEST="$HOME/.deepseek"
    fi
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    MANIFEST_FILE="$MANIFEST_DIR/install-manifest-deepseek.json"
    ;;
  workbuddy)
    BASE_DEST="${DEST:-$HOME/.workbuddy}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  cursor)
    BASE_DEST="${DEST:-$HOME/.cursor}"
    WORKFLOW_DEST="$BASE_DEST/rules"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  windsurf)
    BASE_DEST="${DEST:-$HOME/.windsurf}"
    WORKFLOW_DEST="$BASE_DEST/rules"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  cline|aider|generic)
    BASE_DEST="${DEST:-$HOME/.agent-boost}"
    WORKFLOW_DEST="$BASE_DEST/workflows"
    SKILL_DEST="$BASE_DEST/skills/$SKILL_NAME"
    ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    echo "Supported targets: all, zcode, claude, codex, antigravity, agents, deepseek, opencode, workbuddy, cursor, windsurf, cline, aider, generic" >&2
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
# Refuse to silently take over a skill directory that belongs to someone else.
if [[ -f "$SKILL_DEST/SKILL.md" && "$FORCE" != true ]]; then
  existing_name="$(sed -n 's/^name:[[:space:]]*//p' "$SKILL_DEST/SKILL.md" | head -1)"
  if [[ -n "$existing_name" && "$existing_name" != "$SKILL_NAME" ]]; then
    echo "ERROR: $SKILL_DEST/SKILL.md already defines skill '$existing_name'." >&2
    echo "       Refusing to overwrite it; use --name <alias> or --force." >&2
    exit 3
  fi
fi
if [[ -f "$SKILL_DEST/SKILL.md" ]] && ! sed "s/^name:.*/name: $SKILL_NAME/" "$SCRIPT_DIR/skills/boost/SKILL.md" | cmp -s - "$SKILL_DEST/SKILL.md"; then
  cp "$SKILL_DEST/SKILL.md" "$SKILL_DEST/SKILL.md.bak-${TIMESTAMP}"
fi
sed "s/^name:.*/name: $SKILL_NAME/" "$SCRIPT_DIR/skills/boost/SKILL.md" > "$SKILL_DEST/SKILL.md"
INSTALLED_FILES+=("$SKILL_DEST/SKILL.md")
backup_and_copy "$SCRIPT_DIR/protocol/boost.md" "$SKILL_DEST/protocol/boost.md"
for role_file in "$SCRIPT_DIR"/roles/*.md; do
  if [[ -f "$role_file" ]]; then
    role_base="$(basename "$role_file")"
    backup_and_copy "$role_file" "$SKILL_DEST/roles/$role_base"
  fi
done
echo "Installed skill, protocol, and bilingual role prompts to $SKILL_DEST"

# 2. Install target workflow/adapter
if [[ "$TARGET" == "zcode" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/zcode/boost.dwf.ts" "$WORKFLOW_DEST/$SKILL_NAME.dwf.ts"
  echo "Installed ZCode workflow to $WORKFLOW_DEST/$SKILL_NAME.dwf.ts"
elif [[ "$TARGET" == "claude" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/claude-code/boost.md" "$WORKFLOW_DEST/$SKILL_NAME.md"
  echo "Installed Claude Code command protocol to $WORKFLOW_DEST/$SKILL_NAME.md"
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
  # Skill-scoped filename: other Codex skill packs share the same workflows directory,
  # so a generic "protocol.md" would silently overwrite them (and vice versa).
  backup_and_copy "$SCRIPT_DIR/adapters/codex/protocol.md" "$WORKFLOW_DEST/$SKILL_NAME.protocol.md"
  # Migrate legacy installs: drop the ambiguous protocol.md only when it is byte-identical
  # to this adapter, i.e. the file content is already preserved under the scoped name.
  if [[ -f "$WORKFLOW_DEST/protocol.md" ]] && cmp -s "$SCRIPT_DIR/adapters/codex/protocol.md" "$WORKFLOW_DEST/protocol.md"; then
    rm "$WORKFLOW_DEST/protocol.md"
    echo "Removed legacy ambiguous $WORKFLOW_DEST/protocol.md (content now in boost.protocol.md)"
  fi
  echo "Installed Codex protocol to $WORKFLOW_DEST/$SKILL_NAME.protocol.md"
elif [[ "$TARGET" == "deepseek" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/deepseek/boost.md" "$WORKFLOW_DEST/$SKILL_NAME.md"
  echo "Installed DeepSeek protocol to $WORKFLOW_DEST/$SKILL_NAME.md"
elif [[ "$TARGET" == "antigravity" ]]; then
  # The generic protocol lands inside the skill directory: Antigravity no longer
  # reads the deprecated workflows/ folder.
  backup_and_copy "$SCRIPT_DIR/adapters/generic/boost.md" "$SKILL_DEST/$SKILL_NAME.md"
  echo "Installed Antigravity protocol to $SKILL_DEST/$SKILL_NAME.md"
elif [[ "$TARGET" == "agents" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/generic/boost.md" "$WORKFLOW_DEST/$SKILL_NAME.md"
  echo "Installed universal agents boost protocol to $WORKFLOW_DEST/$SKILL_NAME.md"
elif [[ "$TARGET" == "workbuddy" ]]; then
  backup_and_copy "$SCRIPT_DIR/adapters/workbuddy/boost.md" "$WORKFLOW_DEST/$SKILL_NAME.md"
  echo "Installed WorkBuddy protocol to $WORKFLOW_DEST/$SKILL_NAME.md"
else
  backup_and_copy "$SCRIPT_DIR/adapters/generic/boost.md" "$WORKFLOW_DEST/$SKILL_NAME.md"
  echo "Installed generic protocol ($TARGET) to $WORKFLOW_DEST/$SKILL_NAME.md"
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

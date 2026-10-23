#!/usr/bin/env bash
# Unified installer for agent-boost
set -euo pipefail

TARGET="zcode"
LANG_OPT="zh"
DRY_RUN=false
DEST=""
VERSION="0.2.0"

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
      echo "Usage: $0 [--target zcode|claude|codex|opencode|generic] [--lang zh|en] [--dry-run] [--dest <path>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_DIR="$HOME/.local/share/agent-boost"
MANIFEST_FILE="$MANIFEST_DIR/install-manifest.json"

case "$TARGET" in
  zcode)
    WORKFLOW_DEST="$HOME/.zcode/workflows"
    SKILL_DEST="$HOME/.zcode/skills/boost"
    ;;
  claude)
    WORKFLOW_DEST="$HOME/.claude/commands"
    SKILL_DEST="$HOME/.claude/skills/boost"
    ;;
  codex|opencode|generic)
    if [[ -z "$DEST" ]]; then
      WORKFLOW_DEST="$HOME/.agent-boost/workflows"
      SKILL_DEST="$HOME/.agent-boost/skills/boost"
    else
      WORKFLOW_DEST="$DEST/workflows"
      SKILL_DEST="$DEST/skills/boost"
    fi
    ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

echo "Target platform: $TARGET"
echo "Workflow destination: $WORKFLOW_DEST"
echo "Skill destination:    $SKILL_DEST"

if [[ "$DRY_RUN" == true ]]; then
  echo "[Dry-Run] Target: $TARGET"
  echo "[Dry-Run] Would copy $SCRIPT_DIR/skills/boost/SKILL.md -> $SKILL_DEST/SKILL.md"
  echo "[Dry-Run] Would install workflow/adapter into $WORKFLOW_DEST"
  exit 0
fi

TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUPS_RECORD="{}"

mkdir -p "$WORKFLOW_DEST" "$SKILL_DEST"

# Backup and copy skill
if [[ -f "$SKILL_DEST/SKILL.md" ]]; then
  cp "$SKILL_DEST/SKILL.md" "$SKILL_DEST/SKILL.md.bak-$TIMESTAMP"
fi
cp "$SCRIPT_DIR/skills/boost/SKILL.md" "$SKILL_DEST/SKILL.md"
echo "Installed skill to $SKILL_DEST/SKILL.md"

# Install target workflow/adapter
INSTALLED_FILES=("$SKILL_DEST/SKILL.md")

if [[ "$TARGET" == "zcode" ]]; then
  if [[ -f "$WORKFLOW_DEST/boost.dwf.ts" ]]; then
    cp "$WORKFLOW_DEST/boost.dwf.ts" "$WORKFLOW_DEST/boost.dwf.ts.bak-$TIMESTAMP"
  fi
  cp "$SCRIPT_DIR/adapters/zcode/boost.dwf.ts" "$WORKFLOW_DEST/boost.dwf.ts"
  INSTALLED_FILES+=("$WORKFLOW_DEST/boost.dwf.ts")
  echo "Installed ZCode workflow to $WORKFLOW_DEST/boost.dwf.ts"
elif [[ "$TARGET" == "claude" ]]; then
  cp "$SCRIPT_DIR/adapters/claude-code/boost.md" "$WORKFLOW_DEST/boost.md"
  INSTALLED_FILES+=("$WORKFLOW_DEST/boost.md")
  echo "Installed Claude Code command protocol to $WORKFLOW_DEST/boost.md"
elif [[ "$TARGET" == "opencode" ]]; then
  cp "$SCRIPT_DIR/adapters/opencode/agents.json" "$WORKFLOW_DEST/agents.json"
  INSTALLED_FILES+=("$WORKFLOW_DEST/agents.json")
  echo "Installed OpenCode agents configuration to $WORKFLOW_DEST/agents.json"
elif [[ "$TARGET" == "codex" ]]; then
  cp "$SCRIPT_DIR/adapters/codex/protocol.md" "$WORKFLOW_DEST/protocol.md"
  INSTALLED_FILES+=("$WORKFLOW_DEST/protocol.md")
  echo "Installed Codex protocol to $WORKFLOW_DEST/protocol.md"
else
  cp "$SCRIPT_DIR/adapters/generic/boost.md" "$WORKFLOW_DEST/boost.md"
  INSTALLED_FILES+=("$WORKFLOW_DEST/boost.md")
  echo "Installed generic protocol to $WORKFLOW_DEST/boost.md"
fi

# Record manifest
mkdir -p "$MANIFEST_DIR"
cat <<EOF > "$MANIFEST_FILE"
{
  "version": "$VERSION",
  "target": "$TARGET",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "files": $(printf '%s\n' "${INSTALLED_FILES[@]}" | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'),
  "backup_timestamp": "$TIMESTAMP"
}
EOF

echo "Installation complete. Manifest saved to $MANIFEST_FILE."

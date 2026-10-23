#!/usr/bin/env bash
# Uninstaller for agent-boost
set -euo pipefail

TARGET=""
PURGE_BACKUPS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --purge-backups)
      PURGE_BACKUPS=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--target zcode|claude|codex|opencode|generic] [--purge-backups]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

MANIFEST_DIR="$HOME/.local/share/agent-boost"

if [[ -n "$TARGET" ]]; then
  MANIFEST_FILES=("$MANIFEST_DIR/install-manifest-${TARGET}.json")
else
  shopt -s nullglob
  MANIFEST_FILES=("$MANIFEST_DIR"/install-manifest-*.json)
  shopt -u nullglob
  if [[ ${#MANIFEST_FILES[@]} -eq 0 && -f "$MANIFEST_DIR/install-manifest.json" ]]; then
    MANIFEST_FILES=("$MANIFEST_DIR/install-manifest.json")
  fi
fi

if [[ ${#MANIFEST_FILES[@]} -eq 0 || ! -f "${MANIFEST_FILES[0]}" ]]; then
  echo "No manifest file found in $MANIFEST_DIR. Nothing to uninstall."
  exit 0
fi

for mf in "${MANIFEST_FILES[@]}"; do
  [[ -f "$mf" ]] || continue
  python3 - "$mf" "$PURGE_BACKUPS" <<'EOF'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
purge_backups = sys.argv[2].lower() == "true"
data = json.loads(manifest_path.read_text(encoding="utf-8"))

ts = data.get("backup_timestamp", "")

for f in data.get("files", []):
    fp = Path(f)
    bak = Path(f"{f}.bak-{ts}") if ts else None
    if bak and bak.is_file():
        bak.replace(fp)
        print(f"Restored: {fp} from backup")
    elif fp.is_file():
        fp.unlink()
        print(f"Removed: {fp}")
    if purge_backups and fp.parent.is_dir():
        for old_bak in fp.parent.glob(f"{fp.name}.bak-*"):
            old_bak.unlink()
            print(f"Purged backup: {old_bak}")

manifest_path.unlink()
print(f"Removed manifest: {manifest_path}")
EOF
done

# Clean up legacy manifest pointer if no target manifests remain
shopt -s nullglob
REMAINING=("$MANIFEST_DIR"/install-manifest-*.json)
shopt -u nullglob
if [[ ${#REMAINING[@]} -eq 0 && -f "$MANIFEST_DIR/install-manifest.json" ]]; then
  rm -f "$MANIFEST_DIR/install-manifest.json"
fi

echo "Uninstallation finished."

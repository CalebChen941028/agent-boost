#!/usr/bin/env bash
# Uninstaller for agent-boost
set -euo pipefail

MANIFEST_FILE="$HOME/.local/share/agent-boost/install-manifest.json"

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "No manifest file found at $MANIFEST_FILE. Nothing to uninstall."
  exit 0
fi

python3 - <<EOF
import json
from pathlib import Path

manifest_path = Path("$MANIFEST_FILE")
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

manifest_path.unlink()
print("Removed manifest.")
EOF

echo "Uninstallation finished."

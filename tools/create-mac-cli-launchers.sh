#!/bin/sh
set -eu

release_root="${1:-release}"
found=0

for app_path in "$release_root"/Podcast\ Creator-*/Podcast\ Creator.app; do
  if [ ! -d "$app_path" ]; then
    continue
  fi

  found=1
  app_dir="$(dirname "$app_path")"
  launcher_path="$app_dir/podcast-creator-cli"

  cat > "$launcher_path" <<'EOF'
#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
APP_PATH="$SCRIPT_DIR/Podcast Creator.app"
CLI_ENTRY="$APP_PATH/Contents/Resources/app/electron/cli/podcast-runner.js"

export ELECTRON_RUN_AS_NODE=1
exec "$APP_PATH/Contents/MacOS/Podcast Creator" "$CLI_ENTRY" "$@"
EOF

  chmod +x "$launcher_path"
  printf 'Created %s\n' "$launcher_path"
done

if [ "$found" -eq 0 ]; then
  echo "No packaged app found under $release_root" >&2
  exit 1
fi

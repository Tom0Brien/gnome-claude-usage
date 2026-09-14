#!/usr/bin/env bash
# Installs the extension into ~/.local/share/gnome-shell/extensions and enables it.
set -euo pipefail

UUID="claude-usage@tobrien.local"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

glib-compile-schemas "${SRC}/schemas"

mkdir -p "${DEST}"
cp -f "${SRC}"/metadata.json "${SRC}"/extension.js "${SRC}"/prefs.js "${SRC}"/scanner.js "${SRC}"/themes.js "${SRC}"/stylesheet.css "${DEST}/"
mkdir -p "${DEST}/icons"
cp -f "${SRC}"/icons/*.svg "${DEST}/icons/"
mkdir -p "${DEST}/schemas"
cp -f "${SRC}"/schemas/*.xml "${SRC}"/schemas/gschemas.compiled "${DEST}/schemas/"
chmod +x "${DEST}/scanner.js"

gnome-extensions enable "${UUID}" || true

echo "Installed to ${DEST}"
echo "On Wayland, log out and back in (or restart the shell) to load a new version."

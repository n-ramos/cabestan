#!/usr/bin/env bash
#
# Construit Cabestan et l'installe dans /Applications.
#
# Sans cette étape, l'app lancée depuis le Launchpad reste celle d'un ancien
# build : Tauri écrit dans src-tauri/target et ne touche jamais /Applications.
#
# La signature est ad hoc (« - ») : elle suffit à un usage local et donne au
# bundle une identité stable, ce qui évite que macOS redemande les
# autorisations à chaque installation. Une vraie signature Developer ID
# demanderait un compte Apple.

set -euo pipefail

racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_app="$racine/src-tauri/target/release/bundle/macos/Cabestan.app"
cible="/Applications/Cabestan.app"

if [[ "${1:-}" != "--sans-build" ]]; then
  echo "→ Construction…"
  (cd "$racine" && npm run tauri build -- --bundles app)
fi

[[ -d "$source_app" ]] || { echo "Bundle introuvable : $source_app" >&2; exit 1; }

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "$source_app/Contents/Info.plist")

echo "→ Signature ad hoc…"
codesign --force --deep --sign - "$source_app" 2>/dev/null

# Une app en cours d'exécution ne peut pas être remplacée proprement.
if pgrep -f "$cible/Contents/MacOS" >/dev/null 2>&1; then
  echo "→ Fermeture de la version en place…"
  osascript -e 'quit app "Cabestan"' 2>/dev/null || pkill -f "$cible/Contents/MacOS" || true
  sleep 1
fi

echo "→ Installation dans /Applications…"
rm -rf "$cible"
cp -R "$source_app" "$cible"
# Le drapeau de quarantaine ferait apparaître l'avertissement « développeur
# non identifié » à chaque installation.
xattr -dr com.apple.quarantine "$cible" 2>/dev/null || true

echo "✓ Cabestan $version installée dans /Applications"

#!/usr/bin/env bash
# Imprime las notas de una versión desde CHANGELOG.md (para el Release de GitHub).
#
#   bash scripts/notas-version.sh 0.2.0
#
# Falla si la versión no tiene sección «## [x.y.z]» o si está vacía.
set -euo pipefail
V="${1:?Uso: notas-version.sh x.y.z}"
ARCHIVO="$(dirname "$0")/../CHANGELOG.md"
NOTAS="$(awk -v v="$V" '
  index($0, "## [" v "]") == 1 { dentro = 1; next }
  /^## \[/ { if (dentro) exit }
  /^\[[^]]+\]: https?:/ { next }
  dentro { print }
' "$ARCHIVO")"
if [ -z "$(echo "$NOTAS" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md no tiene notas para la versión $V (sección «## [$V] - fecha»)" >&2
  exit 1
fi
echo "$NOTAS"

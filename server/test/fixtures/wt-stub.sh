#!/usr/bin/env bash
# Fake wt used in tests. Echoes fixture JSON based on argv.
set -euo pipefail
case "$1 ${2:-}" in
  "ps --json")
    echo '[{"project":"apartx-cabinet","slug":"x","branch":"feature/x","port":4231,"pid":12345,"container":"wtdev-apartx-cabinet-x","started":100,"alive":true}]' ;;
  "list --json")
    echo '[{"project":"apartx-cabinet","branch":"feature/x","port":4231,"path":"/w/x"},{"project":"apartx-spaces","branch":"feature/y","port":3512,"path":"/w/y"}]' ;;
  "start "*|"restart "*)
    echo "wt: started $2 ${3:-}" ;;
  "stop "*)
    echo "wt: stopped $2 ${3:-}" ;;
  "logs "*)
    # emit two log lines then exit (stub ignores -f and does not block)
    echo "=> App running"
    echo "mongo connected" ;;
  "projects --json")
    echo '["apartx-server","apartx-cabinet"]' ;;
  "new "*)
    echo "wt: created $2 $3" ;;
  "rm "*)
    echo "wt: removed $2 ${3:-}" ;;
  "link "*)
    echo "wt: linked $2 ${3:-}" ;;
  "unlink "*)
    echo "wt: unlinked $2" ;;
  *) echo "unexpected argv: $*" >&2; exit 2 ;;
esac

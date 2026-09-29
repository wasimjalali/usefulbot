#!/bin/sh
dir="$STUB_KEYCHAIN_DIR"
case "$1" in
  -i)
    read -r _cmd _u _s svc _a _acct _w token
    printf '%s' "$token" > "$dir/$svc" ;;
  find-generic-password)
    [ -f "$dir/$3" ] || exit 44
    cat "$dir/$3" ;;
  delete-generic-password)
    rm -f "$dir/$3" ;;
  *) exit 1 ;;
esac

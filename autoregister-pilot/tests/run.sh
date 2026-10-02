#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh build.sh
g++ -std=c++17 -shared -fPIC -I "$NETSDK_INCLUDE" tests/mock_sdk.cpp -o build/mock-sdk.so
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
binary="$PWD/build/cop-autoregister-pilot"
mock="$PWD/build/mock-sdk.so"
for case in ok login-fail empty incomplete; do
    code=0
    printf '%s\n' 'mock-secret' | MOCK_MODE="$case" "$binary" "$mock" 127.0.0.1 8000 101 admin 1 \
      2026-09-30T10:41:38 2026-09-30T10:42:08 "$tmp/$case.dav" >"$tmp/$case.log" 2>&1 || code=$?
    if [ "$case" = ok ]; then
        test "$code" -eq 0
        test "$(cat "$tmp/$case.dav")" = MOCK_DAV
        grep -q DOWNLOAD_COMPLETE "$tmp/$case.log"
    else
        test "$code" -ne 0
        test ! -e "$tmp/$case.dav"
        grep -q TEST_FAILED "$tmp/$case.log"
    fi
    printf 'PASS %s\n' "$case"
done
for interval in invalid-date long-range; do
    start=2026-02-30T10:00:00
    end=2026-03-01T10:00:00
    if [ "$interval" = long-range ]; then start=2026-09-30T10:00:00; end=2026-09-30T10:03:00; fi
    if "$binary" "$mock" 127.0.0.1 8000 101 admin 1 "$start" "$end" "$tmp/$interval.dav" >/dev/null 2>&1; then
        exit 1
    fi
    printf 'PASS %s\n' "$interval"
done

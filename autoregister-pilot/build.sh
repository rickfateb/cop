#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${NETSDK_INCLUDE:?Informe a pasta include do NetSDK Linux64 3.050}"
test -f "$NETSDK_INCLUDE/dhnetsdk.h"
mkdir -p build
g++ -std=c++17 -Wall -Wextra -pthread -I "$NETSDK_INCLUDE" receiver.cpp -ldl -o build/cop-autoregister-pilot

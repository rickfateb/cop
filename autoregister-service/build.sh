#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${NETSDK_INCLUDE:?Informe a pasta include do SDK Linux64}"
mkdir -p build
g++ -std=c++17 -Wall -Wextra -pthread -I "$NETSDK_INCLUDE" receiver.cpp -ldl -o build/cop-sdk-receiver

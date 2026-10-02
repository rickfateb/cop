#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh build.sh
g++ -std=c++17 -shared -fPIC -I "$NETSDK_INCLUDE" test/mock_sdk.cpp -o build/mock-sdk.so
python3 -m unittest discover -s test -p 'test_*.py' -v

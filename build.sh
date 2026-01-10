#!/usr/bin/env bash
set -euo pipefail

mkdir -p netlify/functions/data
cp -f data/*.gz netlify/functions/data/
echo "Copied data/*.gz into netlify/functions/data/"
ls -lah netlify/functions/data || true

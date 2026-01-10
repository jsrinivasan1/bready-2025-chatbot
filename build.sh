#!/usr/bin/env bash
set -euo pipefail

echo "PWD:"
pwd

echo "Listing source data/ :"
ls -lah data || true
ls -lah data/*.gz || true

echo "Creating netlify/functions/data and copying gz files..."
mkdir -p netlify/functions/data
cp -fv data/*.gz netlify/functions/data/

echo "Listing destination netlify/functions/data/ :"
ls -lah netlify/functions/data || true

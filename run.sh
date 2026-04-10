#!/usr/bin/env bash
# Quick launcher for claude-zoom chat
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
    echo "Creating venv..."
    python3.12 -m venv .venv
    .venv/bin/pip install -e .
fi

source .venv/bin/activate
claude-zoom chat "$@"

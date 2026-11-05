#!/bin/sh
# Serves the app on http://localhost:8765 (the webcam needs localhost or https) and opens it.
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
( sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1

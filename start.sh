#!/bin/bash
cd "$(dirname "$0")"

PORT=9004

# Kill any existing instance on the port
if lsof -ti tcp:$PORT &>/dev/null; then
    echo "Stopping existing process on port $PORT..."
    kill $(lsof -ti tcp:$PORT)
    sleep 1
fi

echo "Starting TenX Stock Analyzer on http://localhost:$PORT"
node scheduler.js &
SCHEDULER_PID=$!
echo "Scheduler started (PID $SCHEDULER_PID)"

node server.js

kill $SCHEDULER_PID 2>/dev/null

#!/bin/bash
# BotForge Overnight Build - Heartbeat Script
# Runs every 15 minutes via cron

LOG="/tmp/botforge-heartbeat.log"
echo "=== HEARTBEAT $(date -u) ===" >> "$LOG"

# Trigger OpenClaw to wake up and do the FULL loop
/home/ubuntu/.npm-global/bin/openclaw system event --text "HEARTBEAT: BotForge overnight build check.

DO ALL OF THESE STEPS:

1. CHECK AGENTS: Run process action:list. For each running agent, check logs with process action:log.

2. MERGE COMPLETED WORK: For any completed agents:
   - Go to their worktree and commit uncommitted files
   - Merge branch into master at /home/ubuntu/botforge
   - Test server boots: cd /home/ubuntu/botforge && timeout 5 node -e \"require('./src/api/server.js')\"
   - Fix any issues, push to GitHub

3. PM LOOP - RESEARCH: Use python3 /home/ubuntu/.openclaw/workspace-midas/tools/perplexity.py to research what features are trending for Discord bot platforms. Check what competitors are doing.

4. PM LOOP - AUDIT: Read the current codebase. What is broken? What is missing? What needs polish? Compare against PM_NOTES.md priorities.

5. PM LOOP - RECORD: Update /home/ubuntu/botforge/PM_NOTES.md with new findings, reprioritized features, and what was shipped.

6. PM LOOP - ACT: Pick the top 2-3 unbuilt features from PM_NOTES.md. Create new git worktrees. Spawn new Codex agents (codex --full-auto exec) to build them. Use pty:true and background:true.

7. POST UPDATE: Send a progress update to Discord channel 1480355375118291115 with what was merged, what agents are running, and what is next.

NEVER STOP. After agents finish, repeat this loop. Keep building until morning." --mode now 2>>"$LOG"

echo "Event sent at $(date -u)" >> "$LOG"

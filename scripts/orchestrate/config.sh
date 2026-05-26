#!/usr/bin/env bash
# =============================================================================
# orchestrate config — THE ONLY FILE YOU EDIT PER PROJECT.
# Everything else in scripts/orchestrate/ is generic. Copy the folder into a
# new repo, edit the values below, create the Linear labels, and run.
# =============================================================================

# Absolute path to the repo the agents implement in.
REPO="/Users/casemiller/Desktop/Nolla-Image-Client"

# Linear project the watchers poll.
#   PROJECT    — the name (used in the MCP write prompts)
#   PROJECT_ID — the UUID (used in the free GraphQL poll filter; from list_projects or the URL)
PROJECT="Image Blaster — Agent Orchestration"
PROJECT_ID="dcdaaa90-35cb-47bb-b864-6c905a6ed9ca"

# Labels that pass the baton (create these three in Linear).
LABEL_TECH="agent:tech"               # ready for the implementer
LABEL_QA="agent:qa"                   # ready for review
LABEL_CHANGES="agent:changes-requested"  # QA bounced it back to tech
LABEL_KEEP="from-claude"              # kept on every agent-touched issue (attribution)

# Workflow state names — must match your Linear team's states exactly.
STATE_TODO="Todo"
STATE_PROGRESS="In Progress"
STATE_REVIEW="In Review"
STATE_DONE="Done"

# Models + safety envelope.
POLL_MODEL="claude-haiku-4-5"     # used only for the (infrequent) MCP writes
WORKER_MODEL="claude-sonnet-4-6"  # the implementer + the reviewer
WORKER_BUDGET="5"                 # $/run cap for the tech implementer
QA_BUDGET="3"                     # $/run cap for the QA reviewer
INTERVAL="${INTERVAL:-45}"        # poll seconds

# NOTE: the Linear agent token (LINEAR_API_KEY=lin_oauth_…) is read from the
# repo's .env by lib.sh — do NOT hardcode it here, and keep .env gitignored.

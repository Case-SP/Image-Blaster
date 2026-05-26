#!/usr/bin/env bash
# Generic helpers for the Linear-orchestrated agent kit.
# Per-project knobs live in config.sh — the only file you edit per project.
# Polling is free Linear GraphQL; the infrequent writes go through `claude -p`
# + the Linear MCP (lin()), tools pre-approved via --allowedTools.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/config.sh"
LOGDIR="$HERE/logs"; mkdir -p "$LOGDIR"

# Linear MCP tools the writes are allowed to call headlessly.
LIN_TOOLS="mcp__linear__list_issues mcp__linear__get_issue mcp__linear__save_issue mcp__linear__save_comment mcp__linear__list_issue_labels"

# LINEAR_API_KEY (the lin_oauth_… agent token) is read from the repo's .env.
[ -f "$REPO/.env" ] && { set -a; . "$REPO/.env"; set +a; }

gql(){ curl -s -m 20 -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY:-}" -H "Content-Type: application/json" --data "$1"; }

ts(){ date "+%H:%M:%S"; }
log(){ echo "[$(ts)] $*"; }

# Run a Linear instruction headlessly; echo the .result text (trimmed).
lin(){
  local prompt="$1"
  claude -p "$prompt" --model "$POLL_MODEL" \
    --allowedTools "$LIN_TOOLS" --output-format json 2>/dev/null \
    | jq -r '.result // empty'
}

# Poll via GraphQL. lin_poll <stateName> <comma-separated label names>
# -> echoes a bare SP-NN identifier, or empty. Structured data; can't hallucinate.
lin_poll(){
  local labels_json vars q
  labels_json=$(printf '%s' "$2" | jq -Rc 'split(",")|map(gsub("^\\s+|\\s+$";""))')
  vars=$(jq -nc --arg p "$PROJECT_ID" --arg st "$1" --argjson l "$labels_json" '{p:$p,st:$st,l:$l}')
  q='query($p:ID!,$st:String!,$l:[String!]){ issues(first:1, filter:{ project:{id:{eq:$p}}, state:{name:{eq:$st}}, labels:{some:{name:{in:$l}}} }){ nodes{ identifier } } }'
  gql "$(jq -nc --arg q "$q" --argjson v "$vars" '{query:$q,variables:$v}')" \
    | jq -r '.data.issues.nodes[0].identifier // empty' 2>/dev/null
}

# Echo an issue's full description markdown.
lin_desc(){ lin "In Linear, read issue $1 and output ONLY its description markdown verbatim, nothing else."; }

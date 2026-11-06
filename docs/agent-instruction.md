# Agent instruction (proposal)

Status: **proposal awaiting the owner.** It is not in the shared agent configuration. The owner adds it after the dry run (requirements section 9). The tool names and parameters match the MCP server (see `docs/api.md`).

The section "Instruction text" is what goes into the shared agent configuration. The section "Connecting to Mikud" is set up once per machine.

## Instruction text

```markdown
## Mikud

Mikud is the owner's board of work items. Keep it current from T3 threads through the `mikud` MCP tools.

**When this applies.** Only in a top-level T3 thread, in any project. A thread that has a parent thread (a subagent, a delegated task or a partner review) does nothing with Mikud. Outside T3, or when you cannot get your thread id, skip Mikud.

**Thread id.** Claude: the `T3CODE_THREAD_ID` environment variable. Other agents: `currentThreadId` from the T3 MCP tool `t3_thread_list`. Take your `parentThreadId` from T3 as well (`orchestrator_capabilities` or your own thread in `t3_thread_list`); when it is set, stop here.

**At thread start**, before other work, call `mikud_start_thread` once with:
- `threadId` and `parentThreadId`;
- `t3ProjectId`: the T3 project id of this thread;
- `title`: what the work is, in at most 80 characters, in the conversation's language;
- `itemId`: only when the user names an existing Mikud item (its id or link; `mikud_find_items` searches by text). Otherwise Mikud finds the item linked to this thread or creates one.

It sets the item to `in_progress`. Remember the item id it returns.

**At the end of the work** (the task is finished, or it now waits on the owner):
1. `mikud_comment` on the item: a summary in 1 to 3 lines, in the conversation's language. What changed and what is left.
2. `mikud_update_item` to the right status:
   - `done`: the work is finished.
   - `waiting_on_you`: only when the owner must act: a decision, a manual test, or approval of a merge.
   - `not_relevant`: the owner dropped the work.
   - Leave `in_progress` when you stopped midway and work will continue.

**Quick capture.** When the user asks to note something for later ("note an idea for X"), call `mikud_capture` with the text and, if named, the project. Without a project it goes to the inbox.

**Notes.** A note keeps knowledge worth finding again; an item is work to do. Write a note when the user asks you to remember or write something down, or when the work settled something that will matter later: a decision and its reason, how a part works, a finding, a useful link.
- First look with `mikud_find_notes` (by text, and by project when there is one). When a note on the subject exists, read it with `mikud_get_note` and update it with `mikud_update_note`, sending the whole new body; do not write a second note on the same subject.
- Otherwise call `mikud_create_note` with a short title and a Markdown body, in the conversation's language, with the project when the knowledge belongs to one.
- The owner's notes may be edited, and every change is kept as a version he can restore. Change only what the work changed; keep the rest of the text as it is.
- On `version_conflict`, read the note again, merge your change into the new text, and retry once.

**Never:**
- Write secrets or environment details into Mikud: no tokens, passwords, keys, host names, IP addresses or server details. If Mikud refuses text with `secret_suspected`, rewrite it without the detail.
- Delete anything. There is no tool for it; deleting belongs to the owner.
- Change a project's stage. Propose one with `mikud_propose_stage` and a one-line reason.

**If Mikud is unreachable or fails**, continue the work, mention it once in your reply, and do not retry in a loop.
```

## Connecting to Mikud

Both clients use the MCP Streamable HTTP transport with an agent key of their own. Get it with `mikud connect` (the sync bundle, [sync.md](sync.md)); the owner approves it in the browser. Replace the example URL with the owner's Mikud address.

Claude Code: run `node dist/sync/mikud-sync.js connect --url https://mikud.example.com --name claude --for claude` in the Mikud checkout. After the approval it runs this itself, replacing an older `mikud` entry at user scope:

```
claude mcp add --transport http --scope user mikud https://mikud.example.com/mcp --header "Authorization: Bearer <key>"
```

Codex: run `... connect --url https://mikud.example.com --name codex --for codex`. It sets `MIKUD_AGENT_KEY` for the Windows user with `setx` (elsewhere in `~/.config/mikud/codex.env`, with the line to add to the shell profile), then runs `codex mcp add mikud --url https://mikud.example.com/mcp --bearer-token-env-var MIKUD_AGENT_KEY`, which writes these lines to `~/.codex/config.toml`. Restart Codex from a new terminal afterwards.

```toml
[mcp_servers.mikud]
url = "https://mikud.example.com/mcp"
bearer_token_env_var = "MIKUD_AGENT_KEY"
```

When `claude` or `codex` is missing or fails, the command prints the same setup once instead. Each agent gets its own key, which ends after `--days` (default 90) or when the owner disconnects it in Settings, Agent access. A printed command can stay in the shell history.

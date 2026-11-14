# Sync tool

Status: built and tested against fixtures and a stub server. The server routes it calls (`/api/v1/sync/t3`, `/api/v1/sync/security`) are on `main`; see [api.md](api.md). Not yet run against an Adiutor server; that happens in the launch checks in production.

`dist/sync/adiutor-sync.js` runs on the owner's PC, started by the T3 scheduled task in [prompts/reconcile.md](../prompts/reconcile.md). It is the only way T3 and GitHub data reach Adiutor: the server never calls T3 or GitHub.

## What one run does

1. Runs the `overview` collector (`node src/cli.mjs collect` in the overview checkout, 20 minute limit), then reads the newest snapshot: the run in `data/latest-run.txt`, or else the newest readable `data/runs/<runId>/snapshot.json`. When the collector fails (for example, another overview run holds its lock), the newest existing snapshot is used and the output says so.
2. Reads the projects file that the scheduled agent wrote from `t3_project_list`. Deleted projects and projects whose id holds characters other than letters, digits, `.`, `_`, `:` and `-` are skipped and counted.
3. Runs `t3 thread list --project <id> --json` for every project, four at a time, 2 minute limit each. Top-level and child threads are both sent with their `parentThreadId`; the server folds child threads into their parent's item. Projects whose threads could not be read, or whose thread list had invalid records, are sent as `failedProjects`, so the server records the run as `partial` and does not decide their items in that run. When no project could be read, the T3 payload is not sent.
4. Finds each project's GitHub repository: from T3's repository identity when its provider is GitHub, otherwise by matching the project's folder (`workspaceRoot` or the identity's `rootPath`) against the snapshot's local repositories and their worktrees, ignoring case and separators.
5. Sends `POST /api/v1/sync/t3`, then `POST /api/v1/sync/security` for the project repositories found in the snapshot, and prints each answer.

The server refuses times more than 5 minutes ahead of its own clock ([api.md](api.md), "Times later than the server's clock"). Keep the PC's clock, and the clocks behind T3's and the collector's times, set automatically. When the PC runs ahead, the run prints `refused (HTTP 400)` with `validation_failed` and Settings, Sync shows the T3 run as failed; a single record that is ahead shows in the answer's `errors` as `time_in_future`.

Security values follow the snapshot honestly: an enabled family sends its alert counts by severity; a family carried over from an earlier run (`stale.since`) keeps its counts with that time as `asOf`; `not-enabled`, `no-access` and `error` keep their meaning; a missing or unrecognized family is `unknown`. `asOf` is always the source's last successful read, never the time of the sync. Code scanning rule levels are counted, never dropped: `error` and an unknown severity as medium, `warning` and `note` as low.

## Settings

Read from the environment, or from a `--env` file of `KEY=VALUE` lines, which wins over the environment:

| Name                   | Purpose                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADIUTOR_URL`          | Base URL of the Adiutor server, for example `https://adiutor.example.com`                                                                                                                      |
| `ADIUTOR_AGENT_TOKEN`  | The sync's agent key (`adt_...`), written by `connect --for sync`. Never accepted on the command line, never printed (any echo is replaced with `[redacted]`), never passed to a child process |
| `T3CODE_CLI_PATH`      | The T3 CLI. T3 sets it for its agents; on Windows it is a `.cmd` file                                                                                                                          |
| `ADIUTOR_OVERVIEW_DIR` | The `overview` checkout; `--overview` overrides it                                                                                                                                             |

Keep the env file outside every repository: `connect` writes `%LOCALAPPDATA%\adiutor\sync.env` on Windows and `~/.config/adiutor/sync.env` elsewhere, readable only by the owner.

## Commands

```
node dist/sync/adiutor-sync.js run --projects <file> [--env <file>] [--overview <dir>] [--no-collect] [--dry-run]
```

- `--no-collect` uses the newest existing snapshot without running the collector.
- `--dry-run` prints the payload sizes and a sample and sends nothing; it needs no URL or token.
- Exit code 0 when at least one payload was accepted (or a dry run had something to send), 1 when nothing could be sent, 2 for bad arguments or settings.

## Connecting an agent or the sync

```
node dist/sync/adiutor-sync.js connect --name <name> --for <sync|claude|codex> [--days <1-365>] [--url <url>] [--env <file>] [--no-open]
```

The owner approves the agent in the browser, then the command gets one agent key for it (Better Auth's device authorization; [api.md](api.md), "Agent approval").

1. It asks Adiutor for a code (client id `adiutor-connect`), prints the approval link and the code (`ABCD-EFGH`) and opens the browser (`%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` elsewhere, never a shell; `--no-open` skips it). The link must be on the address given.
2. It polls every 5 seconds (5 more after each `slow_down`) until the owner allows or denies, or the code ends after 10 minutes.
3. Once allowed, it holds a session token for a few seconds: it creates one key named `--name` that works `--days` days (default 90), then ends that session with `/revoke-session` in a `finally`, also when the key could not be created or saved. When the end is not confirmed, it says so: end the session "adiutor connect (agent approval)" on the Account page. The session token is never printed or stored. A key Adiutor answers is used only when it is `adt_` followed by letters and digits (Adiutor makes `adt_` and 64 letters); anything else in a successful answer is neither saved, printed nor passed on, and `connect` asks to disconnect that key in Settings, Agent access.
4. What it gives:
   - `--for sync`: before asking Adiutor for anything, it creates the env file (`--env`, or the default above) and restricts it to the current user: on Windows `%SystemRoot%\System32\icacls.exe <file> /inheritance:r /grant:r <DOMAIN\user>:F`, read back and refused unless that user is the only entry (without icacls there, the file is refused and no key is created); elsewhere mode 0600 in a 0700 folder. It then sets `ADIUTOR_URL` and `ADIUTOR_AGENT_TOKEN` in the file and keeps every other line. The key is not printed.
   - `--for claude`: runs `claude mcp add --transport http --scope user adiutor <url>/mcp --header "Authorization: Bearer <key>"`. Claude Code refuses a name that exists. Only that refusal, its message `MCP server adiutor already exists in user config`, makes it run `claude mcp remove adiutor --scope user` and add again; any other failure (a managed policy that allows only plugin servers, for one) removes nothing and falls back to the printed command. The message is read instead of checking first with `claude mcp get`, which looks at every scope and connects to the server; should the wording change, nothing is removed. Claude Code keeps the key in its own user configuration (`~/.claude.json`, or in the folder `CLAUDE_CONFIG_DIR` names). Start a new Claude Code session to use it.
   - `--for codex`: first sets the variable `ADIUTOR_AGENT_KEY` to the key: on Windows with `%SystemRoot%\System32\setx.exe` for the Windows user; elsewhere in `~/.config/adiutor/codex.env` (`$XDG_CONFIG_HOME/adiutor/` when it is set), mode 0600 in a 0700 folder, holding one `export ADIUTOR_AGENT_KEY='<key>'` line, and it prints the line `. "<file>"` to add to the shell profile once. It then runs `codex mcp add adiutor --url <url>/mcp --bearer-token-env-var ADIUTOR_AGENT_KEY`, which replaces an entry of the same name, so Codex's `config.toml` (in `~/.codex`, or in `CODEX_HOME`) names the variable and never holds the key. Restart Codex from a new terminal so that it sees the variable. On Windows, `setx` reaches only programs started afterwards: a terminal, an IDE or another app that was already open and starts Codex needs a restart too.
   - `claude` and `codex` are looked up on `PATH` (absolute entries only; on Windows `.com`, `.exe`, `.bat` and `.cmd` in `PATHEXT`'s order, so npm's `codex.cmd` runs through `cmd.exe` as below). When one is not found or fails, `connect` says why and prints that step's setup instead: the `claude mcp add` command, or the `[mcp_servers.adiutor]` lines for `config.toml`. When the variable cannot be set, it prints the `setx` (or `export`) line. Only these fallback lines show the key; outside Windows they hold it in single quotes.
5. `--url` falls back to `ADIUTOR_URL` in the environment, then in the env file. It must be https, or http on `localhost` or `127.0.0.1` only.

Adiutor never logs a key. It is passed to `claude mcp add` and `setx` as an argument of that short child process, which is how both take it; Claude Code then keeps it in its configuration, and Windows keeps `ADIUTOR_AGENT_KEY` in the user's environment. A printed fallback command can stay in the shell history; clear that entry where others can read it. Exit code 0 when connected, 1 when not, 2 for bad arguments.

## Building it on the PC

`dist/` is not tracked. Build the bundle from the Adiutor checkout in WSL:

```bash
source scripts/lib/common.sh && build_toolchain && install_deps && in_toolchain "pnpm build:sync"
```

The bundle needs only Node.js 24 or later on Windows; it has no runtime dependencies. The server runs on Node.js 26, but `build:sync` stays at `--target=node24` on purpose, because the PC runs Node.js 24. After the PC moves to Node.js 26, the target can move to `node26` too.

## Safety

- Child processes run through `execFile` with an argument array and no shell. Started by bare name, Node looks in the current folder before `PATH` on Windows, so every command runs by its full path: `icacls`, `rundll32` and `setx` from `%SystemRoot%\System32` (where Windows installs them; only administrators can write there), `claude` and `codex` from the absolute `PATH` entries, and the T3 CLI from `T3CODE_CLI_PATH`. Node refuses to start a `.cmd` file without a shell, so the T3 CLI runs as `cmd.exe /d /v:off /s /c ""<cli>" "thread" "list" "--project" "<id>" "--json""`, and so does `codex.cmd` for `connect --for codex`. Every part is quoted; a part holding a quote, a percent sign or a line break is refused, because `cmd.exe` would still expand or split it inside quotes.
- Titles, paths and other text from T3 and the snapshot travel only as JSON to the API, never into a command line or a prompt.
- Redirects are refused, so the token is sent only to `ADIUTOR_URL`, and `connect`'s session token only to `--url`.

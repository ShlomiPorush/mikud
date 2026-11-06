# Mikud requirements

Status: approved by the owner on 2026-11-01. Nothing in this document is implemented yet; see [project-foundation.md](project-foundation.md) for the build plan and status.

Mikud (Hebrew for "focus") is a personal, single-user system that shows the owner what needs him across all of his projects. The UI is in Hebrew (right to left) first. This document uses English names for every concept; the Hebrew labels live only in the Hebrew locale file.

## 1. Problem

The owner runs about 30 projects, code and non-code, through T3 Code agent threads. A previous daily overview page showed repository hygiene (dependency PRs, CI failures, a long list of alerts) instead of his work. He opened it and closed it within a minute. Mikud must answer, in a few seconds each morning: what waits on me, what changed since I last looked, and is anything critical in security.

- T3 is the source of truth for work. Git is one input, not the model.
- Kanzo (github.com/emanuele-em/kanzo) inspired the idea (a small board that agents update over MCP). Kanzo is AGPL: take ideas only, never code.

## 2. Users and access

- Users: the owner and his AI agents. No other people, no roles beyond owner and agent.
- Devices: the owner's desktop and his phone.
- Network: reachable only over the owner's private overlay network (NetBird). Never published to the internet.
- Every API and MCP call from an agent or the sync carries an agent key, in addition to the network restriction. An agent or the sync gets its key from `mikud connect` after the owner approves it in the browser; the key never shows in the UI. Settings, Agent access lists the keys and disconnects them. There is no owner key: owner actions happen in the signed-in browser.
- The owner's browsers sign in (owner's decision, 2026-11-01, replacing "There is no login screen" and the paste-a-token pairing of browsers): one account with a username and a password, and a TOTP code from an authenticator app, which is required. The first run creates the account, sets up TOTP and shows 10 backup codes once. A browser stays signed in while the owner opens Mikud there at least once in 30 days (owner's setting, 1 to 90 days); he can see the signed-in browsers, sign out the others or sign out everywhere, change the password, make new backup codes and set up a new authenticator, on an Account page of its own that the account menu opens (owner's decision, 2026-11-03; it was a Settings section). A forgotten password is reset by a command run on the server, never a route over the network; a lost authenticator is replaced with a backup code. Authentication uses Better Auth only as it documents itself (owner's decision, 2026-11-02); what it does not guarantee is listed as accepted gaps in the foundation plan, "Security design".

## 3. Domain model

### Project

- Fields: name, stage, near goal, count of items closed toward that goal out of the items attached to it, a one-line "where we are", a link to the GitHub repository and its open Issues count (Issues stay in GitHub: no import, no sync).
- Stages: `idea` → `poc` → `development` → `production`, plus `redesign` and `frozen`.
- Only the owner changes a stage. Agents may propose a stage change; the proposal waits for the owner.
- Every T3 project is a Mikud project. A project with no open items does not appear in the overview.
- A project's stage may be unset until the owner sets it. Drafts written by agents arrive as stage proposals.

### Item (card)

- A task or an idea inside a project, or in the unsorted inbox when it has no project yet.
- Type: `bug`, `decision`, `security`, `task`, `idea`.
- Status: `future` → `todo` → `in_progress` → `waiting_on_you` → `done`. An item may also close as `not_relevant`.
- `waiting_on_you` only when the owner must act: a decision, a manual test, a merge approval.
- An item may link several T3 threads. Only top-level T3 threads count; subagent and partner-review threads fold into their parent.
- Comments: agents leave a summary comment when a thread ends.
- Security items carry a severity (`critical`, `high`, `medium`, `low`).

### Rules for agents

- Agents may create items, comment, change status, mark items `done` or `not_relevant`, and update a project's "where we are".
- Agents may not delete items or projects. Deleting is owner-only, in the UI.
- Agents may not change a stage; they propose one.
- Agents never write secrets into Mikud: no tokens, passwords, keys, hostnames, IP addresses or other server details.
- Every change, by anyone, goes to an audit log.

### Inbox

- Quick capture lands in the unsorted inbox when no project is given. The owner sorts it later in the UI.
- Quick add works from the board UI, from any T3 agent ("note an idea for Project X"), and from the Telegram bot.

### Archive

- Closed items (`done`, `not_relevant`) leave the overview after 7 days and stay in the archive.

## 4. Overview (home screen)

The home screen is named Overview (owner's decision, 2026-11-03; it was the morning view). The Telegram morning message keeps its name: it goes out at 08:00. The view uses the whole width of the content area, as the other list pages do.

The parts, in reading order:

1. **Waiting on you**: items in `waiting_on_you` and pending stage proposals.
2. **Security**: one line per project, not a list of alerts (see section 6).
3. **New since your last visit**: items created or changed since the previous visit, marked unread.
4. **Agent updates**: comments and status changes by agents since the last visit, folded by project.
5. **Projects**: for every project with open items: stage, near goal with progress, "where we are", open Issues count.

On a wide screen the view has two columns: the first holds Waiting on you, then Security; the second holds New since your last visit, then Agent updates. Projects span both columns below them. On a narrow screen it is one column in the reading order, Waiting on you first. The order on screen, for the keyboard and for a screen reader is the same reading order.

The inbox count is visible on the home screen and links to the inbox.

## 5. Telegram

- A new, separate Telegram bot (not the one n8n-ops uses).
- Morning message at 08:00 Asia/Jerusalem, Sunday to Friday: 3 to 6 lines covering waiting on you, new, and security, with deep links into the board.
- When the last T3 sync is stale, the message states the time of the last sync.
- The bot accepts plain text from the owner and files it as an item in the inbox. It ignores every other chat.
- The bot token and the owner's chat id are set in Settings and take effect without a restart; an environment variable may set either one instead, and Settings then shows it locked. Sign-in codes may be sent to the Telegram chat as a second factor, off by default.

## 6. Security line

- One line per project, only when there is something to say.
- Critical findings count in every project. High findings count only in projects at stage `production`.
- Sources: GitHub alerts (Dependabot, code scanning, secret scanning) as collected by the owner's existing `overview` collector, and open items of type `security` filed by agent audits.

## 7. Agents and T3

- **Primary mechanism: an agent instruction** in the owner's shared agent configuration. At thread start: find or create the item, link the T3 thread, set `in_progress`. At the end: a summary comment and the right status.
- **Safety net: a daily reconciler.** A T3 scheduled task on the owner's PC runs before the morning message. It first runs the `overview` collector, then reads T3 threads, creates items for top-level threads that have none, and fixes status mismatches: running → `in_progress`, waiting for the owner → `waiting_on_you`, settled → `done`.
- The reconciler never overrides the owner: it does not change an item whose status the owner set after the thread's last activity, never recreates an item or project the owner deleted, and decides from all threads linked to an item together.
- The schedule is bound to one dedicated thread in a T3 project whose default thread mode is `local`, because fresh scheduled threads in a git project try to create worktrees.
- The reconciler also carries the security and Issues counts from the `overview` collector to Mikud, with how fresh each source is.
- The server keeps serving when the PC is off; only the sync stops, and the board and the morning message say since when.

## 8. Operations

- One application container in the same style as n8n-ops: TypeScript, PostgreSQL, an MCP server and a web UI. In production the database is a new database on a PostgreSQL server the owner already runs (owner's decision, 2026-11-01).
- The owner deploys to production himself, on the server that hosts n8n-ops, reachable only over NetBird. The repository provides the image, a production Compose file and deployment notes; agents do not deploy.
- The owner backs up the database with his own tools (owner's decision, 2026-11-01). Mikud has no backup feature.
- Private deployment values (hostnames, addresses, network details, keys) live only on the server and in ignored local notes, never in the repository.
- Every setting the owner manages lives in Settings with a default; an environment variable may override one and the UI then shows it locked. Only the database connection, file paths, deployment wiring and the encryption keys live in the environment alone.

## 9. Launch gate

There is one launch and no partial use.

1. Everything in this document is built and verified, except section 10 (Notes), which the launch does not wait for.
2. Dry run on real data, on the development stack on the owner's PC: every project is seeded with drafts (a stage proposal, goal, "where we are") written by an agent from T3 threads and the repositories; one real Telegram morning message is sent; the overview is shown at desktop and phone sizes.
3. The owner reviews and approves or corrects.
4. Only after approval: the owner deploys to production, the agent instruction goes into the shared agent configuration (proposed to the owner, who adds it), the reconciler schedule is enabled, and the `overview` daily page and its schedule are retired. The `overview` collector stays, run by the reconciler.

## 10. Notes

Status: approved by the owner on 2026-11-03. It is not part of the launch gate (section 9): the launch does not wait for it. The owner decided on 2026-11-06 that it may be built before the launch.

Notes are where the owner and his agents keep information worth finding again: decisions, explanations, findings, links and summaries. An item is work to do and closes; a note is knowledge and does not close.

- Fields: a title, a Markdown body and an optional project. A note without a project is a general note.
- Every change keeps the previous version. The owner sees a note's versions, who wrote each one and when, and restores any of them; a restore is a new version.
- Agents may find, read, create and edit notes, the owner's notes included, over MCP and the HTTP API. Agents may not delete a note; deleting is owner-only, in the UI.
- The rules for agents (section 3) apply to notes: text written by agents and the bot is checked for secrets, and every change goes to the audit log. Notes are not a place for secrets or server details.
- UI: a Notes page in the sidebar with search and filters (project; written by the owner or by an agent), a project's notes on its project page, and a Markdown editor with a preview that is correct in Hebrew (RTL) and English (LTR). Notes created or changed by agents appear in Agent updates on the Overview.
- Telegram: the bot files text in the inbox as an item, as in section 5, and its answer carries a button that moves the text into a new general note. When the owner does not press it, the item stays in the inbox and nothing is lost. Pressing it closes the inbox item as `not_relevant` with a comment that links the note (owner's decision, 2026-11-06); the bot never deletes an item.
- Search runs in PostgreSQL, with no extra service.
- The agent instruction says when an agent writes a note and when it files an item.
- Not in the first version: files and images (Mikud keeps its state only in PostgreSQL and has no volume), tags, and links between notes.
- Considered and not adopted (2026-11-03): running AFFiNE next to Mikud, or taking its code. Its server is under the AFFiNE Enterprise Edition license with no per-file boundary to the MPL 2.0 parts, its documents are CRDT updates written in the browser (outside the services layer, the audit and the secret check), and its right-to-left support has open issues. Ideas only, as with Kanzo.

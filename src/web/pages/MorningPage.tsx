// The morning view (requirements section 4): the figure strip and the stale-sync banner, then two columns
// from 1001px: waiting on you and security (one line per project) in the first, new since your last visit and
// agent updates folded by project in the second; the projects with open items span both below. At 1000px and
// below it is one column in the same order, waiting on you first (v3 NL-17). Each column is its own wrapper, so
// the DOM order (waiting, security, new, agent updates, projects) is the visual, keyboard and screen-reader
// order: nothing is reordered by CSS. The inbox count links to the inbox; the last T3 sync time shows, with a
// banner when it is stale.

import { ChevronRight } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { AgentUpdateGroup, Morning, MorningProject, SecurityLine } from "../api/types.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ProposalRow } from "../shell/Bell.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { useOpenItem } from "../shell/items.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Banner, Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Progress, StageTag, StatusTag } from "../ui/tags.tsx"
import { actorActivity } from "./audit.ts"
import { ItemRow, Panel, rowKeys, selecting } from "./parts.tsx"

export function MorningPage() {
  const { t } = useI18n()
  usePageMeta(t("morning.title"))
  // "New since your last visit" stays as the first read showed it for as long as the page is open:
  // every refresh passes that read's boundary back, so nothing disappears unseen.
  const [since, setSince] = useState<string | null>(null)
  const morning = usePageQuery({
    queryKey: since ? qk.morningSince(since) : qk.morning,
    queryFn: () => (since ? api.morningSince(since) : api.morning()),
    every: EVERY.live,
    keepPrevious: true,
  })
  const page = useRef<HTMLDivElement>(null)
  const visited = useRef(false)
  const shown = morning.data

  useEffect(() => {
    if (!shown) return
    if (since === null) setSince(shown.since)
    if (visited.current) return
    visited.current = true
    // After a read was shown, at that read's server time: nothing newer than what was shown is marked seen.
    api.visit(shown.now).catch(() => {
      // A visit that was not recorded only means the next "new since" list is longer.
    })
  }, [shown, since])

  const scrollTo = (id: string) => {
    const scroller = page.current
    const target = document.getElementById(id)
    if (scroller && target) scroller.scrollTo({ top: target.offsetTop - scroller.offsetTop - 8, behavior: "smooth" })
    target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true })
  }

  return (
    <div className="ui-page" ref={page}>
      <div className="ui-section">
        <PageHead title={t("morning.title")} description={t("morning.description")} />
        {morning.isPending ? <Loading label={t("morning.loading")} /> : null}
        {morning.isError && !morning.data ? (
          <ErrorState title={t("morning.failed")} error={morning.error} onRetry={() => void morning.refetch()} />
        ) : null}
        {morning.data ? <MorningBody morning={morning.data} refreshFailed={morning.isError} onJump={scrollTo} /> : null}
      </div>
    </div>
  )
}

function MorningBody({
  morning,
  refreshFailed,
  onJump,
}: {
  morning: Morning
  refreshFailed: boolean
  onJump: (id: string) => void
}) {
  const { t, tc } = useI18n()
  const waiting = morning.waiting.length
  const securityLines = morning.security.filter((line) => line.critical > 0 || line.high > 0)
  return (
    <>
      <StaleNote failed={refreshFailed} />
      {morning.sync.stale ? (
        <Banner tone="warn" title={morning.sync.lastSuccessAt ? t("sync.staleTitle") : t("sync.neverTitle")}>
          {morning.sync.lastSuccessAt ? (
            <>
              {t("sync.staleBody")} <Time value={morning.sync.lastSuccessAt} mode="full" />.
            </>
          ) : (
            t("sync.neverBody")
          )}
          {morning.sync.lastPartialAt ? (
            <>
              {" "}
              {t("sync.partialBody")} <Time value={morning.sync.lastPartialAt} mode="full" />.
            </>
          ) : null}
        </Banner>
      ) : null}

      <div className="ui-kpis">
        <button type="button" className="ui-kpi ui-kpi-btn" onClick={() => onJump("waiting")}>
          {t("morning.kpiWaiting")}
          <b className={waiting ? "ui-text-warn" : undefined}>{formatNumber(waiting)}</b>
          <small>{waiting ? tc("morning.kpiWaitingHint", waiting) : t("morning.kpiNothing")}</small>
        </button>
        <button type="button" className="ui-kpi ui-kpi-btn" onClick={() => onJump("new")}>
          {t("morning.kpiNew")}
          <b>{formatNumber(morning.new.length)}</b>
          <small>
            {t("morning.since")} <Time value={morning.since} />
          </small>
        </button>
        <Link to="/inbox" className="ui-kpi">
          {t("morning.kpiInbox")}
          <b className={morning.inboxCount ? "ui-text-warn" : undefined}>{formatNumber(morning.inboxCount)}</b>
          <small>{morning.inboxCount ? t("morning.kpiInboxHint") : t("morning.kpiInboxEmpty")}</small>
        </Link>
        <div className="ui-kpi">
          {t("morning.kpiSync")}
          <b className={morning.sync.stale ? "ui-text-warn" : undefined}>
            {morning.sync.lastSuccessAt ? <Time value={morning.sync.lastSuccessAt} /> : "-"}
          </b>
          <small>
            {morning.sync.lastPartialAt ? (
              <>
                {t("sync.partial")} <Time value={morning.sync.lastPartialAt} mode="ago" />
              </>
            ) : morning.sync.lastSuccessAt ? (
              <Time value={morning.sync.lastSuccessAt} mode="ago" />
            ) : (
              t("sync.never")
            )}
          </small>
        </div>
      </div>

      <div className="ui-morning">
        <div className="ui-morning-col" data-column="first">
          <Panel id="waiting" title={t("morning.waitingTitle")} count={waiting}>
            {waiting === 0 ? <Empty title={t("morning.waitingEmpty")} hint={t("morning.waitingEmptyHint")} /> : null}
            {morning.waiting.map((entry) =>
              entry.kind === "stage_proposal" ? (
                <ProposalRow key={entry.proposal.id} proposal={entry.proposal} />
              ) : (
                <ItemRow key={entry.item.id} item={entry.item} />
              ),
            )}
          </Panel>

          <Panel id="security" title={t("morning.securityTitle")} count={securityLines.length}>
            {securityLines.length === 0 ? <Empty title={t("morning.securityEmpty")} hint={t("security.rule")} /> : null}
            {securityLines.map((line) => (
              <SecurityRow key={line.projectId} line={line} />
            ))}
          </Panel>
        </div>

        <div className="ui-morning-col" data-column="second">
          <Panel
            id="new"
            title={t("morning.newTitle")}
            count={morning.new.length}
            extra={
              <span className="ui-muted ui-num">
                {t("morning.since")} <Time value={morning.since} mode="full" />
              </span>
            }
          >
            {morning.new.length === 0 ? <Empty title={t("morning.newEmpty")} hint={t("morning.newEmptyHint")} /> : null}
            {morning.new.map((entry) => (
              <ItemRow
                key={entry.item.id}
                item={entry.item}
                badge={entry.change === "created" ? t("morning.created") : t("morning.updated")}
              />
            ))}
          </Panel>

          <Panel
            id="updates"
            title={t("morning.updatesTitle")}
            count={morning.agentUpdates.reduce((sum, group) => sum + group.updates.length, 0)}
          >
            {morning.agentUpdates.length === 0 ? (
              <Empty title={t("morning.updatesEmpty")} hint={t("morning.updatesEmptyHint")} />
            ) : null}
            {morning.agentUpdates.map((group) => (
              <UpdateGroup key={group.projectId ?? "inbox"} group={group} />
            ))}
          </Panel>
        </div>

        <Panel
          id="projects"
          title={t("morning.projectsTitle")}
          count={morning.projects.length}
          extra={
            <Link to="/projects" className="ui-more">
              {t("morning.allProjects")}
            </Link>
          }
        >
          {morning.projects.length === 0 ? (
            <Empty title={t("morning.projectsEmpty")} hint={t("morning.projectsEmptyHint")} />
          ) : (
            <ProjectTable projects={morning.projects} />
          )}
        </Panel>
      </div>
    </>
  )
}

function SecurityRow({ line }: { line: SecurityLine }) {
  const { t, tc } = useI18n()
  const navigate = useNavigate()
  const open = () => navigate(`/projects/${line.projectId}`)
  const parts = [
    line.critical ? tc("security.critical", line.critical) : null,
    line.high ? tc("security.high", line.high) : null,
  ].filter(Boolean)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
    <div
      className="ui-alert"
      data-tone={line.critical ? "fail" : "warn"}
      data-row-open=""
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (!selecting(event)) open()
      }}
      onKeyDown={rowKeys(open)}
    >
      <i className="ui-alert-bar" />
      <div className="ui-alert-text">
        <span className="ui-alert-title">
          <bdi dir="auto">{line.projectName}</bdi>
          <span className={line.critical ? "ui-text-fail" : "ui-text-warn"}>
            {parts.join(t("common.listSeparator"))}
          </span>
        </span>
        <p>
          {line.asOf ? (
            <span className={line.stale ? "ui-text-warn" : undefined}>
              {line.stale ? t("security.staleAsOf") : t("security.asOf")} <Time value={line.asOf} mode="full" />
            </span>
          ) : (
            t("security.asOfUnknown")
          )}
        </p>
      </div>
    </div>
  )
}

function UpdateGroup({ group }: { group: AgentUpdateGroup }) {
  const { t } = useI18n()
  const openItem = useOpenItem()
  return (
    <details className="ui-fold">
      <summary>
        <ChevronRight aria-hidden="true" />
        {group.projectName ? (
          <bdi dir="auto">{group.projectName}</bdi>
        ) : group.generalNotes ? (
          t("notes.general")
        ) : (
          t("inbox")
        )}
        <span className="ui-count ui-num">{formatNumber(group.updates.length)}</span>
      </summary>
      {group.updates.map((update) => (
        <div
          key={`${update.kind}-${update.kind === "note" ? update.noteId : update.itemId}-${update.at}`}
          className="ui-update"
        >
          <div>
            {update.kind === "note" ? (
              <Link className="ui-row-title" dir="auto" to={`/notes/${update.noteId}`}>
                {update.noteTitle}
              </Link>
            ) : (
              <button type="button" className="ui-row-title" dir="auto" onClick={() => openItem(update.itemId)}>
                {update.itemTitle}
              </button>
            )}
            {update.kind === "comment" ? (
              <p className="ui-user" dir="auto">
                {update.text}
              </p>
            ) : null}
            <span className="ui-item-meta">
              <ActorActivityLink kind={update.actorKind} label={update.actorLabel} />
              {update.kind === "status" ? (
                <>
                  {t("morning.setStatus")} <StatusTag status={update.to} />
                </>
              ) : update.kind === "note" ? (
                <span>{update.change === "created" ? t("morning.noteCreated") : t("morning.noteChanged")}</span>
              ) : (
                <span>{t("morning.commented")}</span>
              )}
            </span>
          </div>
          <Time value={update.at} />
        </div>
      ))}
    </details>
  )
}

/** The actor of an agent update, as a link to its own activity (audit A-2): an agent by its label, the sync. */
function ActorActivityLink({ kind, label }: { kind: AgentUpdateGroup["updates"][number]["actorKind"]; label: string }) {
  const { t } = useI18n()
  const to = actorActivity(kind, label)
  if (!to) return <bdi dir="auto">{label}</bdi>
  return (
    <Link to={to} className="ui-link" title={t("activity.openAgent", { agent: label })}>
      <bdi dir="auto">{label}</bdi>
    </Link>
  )
}

export function issuesUrl(repo: string): string {
  return `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/issues`
}

export function ProjectTable({ projects }: { projects: MorningProject[] }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  return (
    <div
      className="ui-table ui-stack"
      style={
        {
          "--ui-cols": "minmax(0, 1.2fr) 120px minmax(0, 1fr) minmax(0, 1.6fr) 90px",
          "--ui-table-min": "760px",
        } as CSSProperties
      }
    >
      <div className="ui-tr ui-tr-head" aria-hidden="true">
        <span>{t("projects.colName")}</span>
        <span>{t("projects.colStage")}</span>
        <span>{t("projects.colGoal")}</span>
        <span>{t("projects.colWhere")}</span>
        <span className="ui-td-end">{t("projects.colIssues")}</span>
      </div>
      {projects.map((project) => {
        const open = () => navigate(`/projects/${project.id}`)
        return (
          // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
          <div
            key={project.id}
            className="ui-tr"
            data-row-open=""
            role="button"
            tabIndex={0}
            aria-label={t("projects.openNamed", { name: project.name })}
            onClick={(event) => {
              if (!selecting(event) && !(event.target as HTMLElement).closest("a")) open()
            }}
            onKeyDown={rowKeys(open)}
          >
            <span className="ui-td ui-td-first">
              <b dir="auto">{project.name}</b>
            </span>
            <span className="ui-td">
              <StageTag stage={project.stage} />
            </span>
            <span className="ui-td" title={project.goal?.text}>
              {project.goal ? (
                <Progress done={project.goal.done} total={project.goal.total} />
              ) : (
                <span className="ui-muted">{t("projects.noGoal")}</span>
              )}
            </span>
            <span
              className={project.whereWeAre ? "ui-td" : "ui-td ui-td-blank"}
              dir="auto"
              title={project.whereWeAre ?? undefined}
            >
              {project.whereWeAre ?? <span className="ui-muted">-</span>}
            </span>
            <span className="ui-td ui-td-end">
              <span className="ui-td-label">{t("projects.colIssues")} </span>
              {project.repo && project.openIssues !== null ? (
                <a
                  href={issuesUrl(project.repo)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("projects.issuesTitle", { repo: project.repo })}
                >
                  {formatNumber(project.openIssues)}
                </a>
              ) : (
                <span className="ui-muted">-</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

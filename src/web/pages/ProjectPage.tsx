// One project: its stage (the owner sets it; agents only propose), its near goal with progress,
// "where we are", its items grouped by status, where its security data comes from, and deleting it.

import { useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Plus } from "lucide-react"
import { type CSSProperties, type FormEvent, useId, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { LIMITS } from "../../shared/api.ts"
import { CLOSED_STATUSES, type ItemStatus, SEVERITIES, STAGES, type Stage } from "../../shared/enums.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { ItemSummary, Project, ProjectDetail, SecuritySource } from "../api/types.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ProposalRow } from "../shell/Bell.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { useRefreshItems } from "../shell/items.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { QuickAdd } from "../shell/QuickAdd.tsx"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Progress, StageTag, Tag } from "../ui/tags.tsx"
import { issuesUrl } from "./MorningPage.tsx"
import { ProjectNotes } from "./NotesPage.tsx"
import { ItemRow, Panel } from "./parts.tsx"

const OPEN_ORDER: ItemStatus[] = ["waiting_on_you", "in_progress", "todo", "future"]

export function ProjectPage() {
  const { projectId = "" } = useParams()
  const { t } = useI18n()
  const query = usePageQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.project(projectId),
    every: EVERY.live,
  })
  const detail = query.data
  usePageMeta(detail?.project.name ?? t("project.loadingTitle"), [{ label: t("projects.title"), to: "/projects" }])

  if (query.isPending) {
    return (
      <div className="ui-page">
        <Loading label={t("project.loading")} />
      </div>
    )
  }
  if (!detail) {
    const missing = query.error instanceof ApiError && query.error.code === "not_found"
    return (
      <div className="ui-page">
        {missing ? (
          <div className="ui-panel">
            <Empty title={t("project.notFound")} hint={t("project.notFoundHint")} />
          </div>
        ) : (
          <ErrorState title={t("project.failed")} error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    )
  }
  return <ProjectBody detail={detail} refreshFailed={query.isError} />
}

function ProjectBody({ detail, refreshFailed }: { detail: ProjectDetail; refreshFailed: boolean }) {
  const project = detail.project
  const { t, tc } = useI18n()
  const [editing, setEditing] = useState<"goal" | "where" | "add" | null>(null)
  const openItems = detail.items.filter((item) => !(CLOSED_STATUSES as readonly string[]).includes(item.status))
  const closedItems = detail.items.filter((item) => (CLOSED_STATUSES as readonly string[]).includes(item.status))
  const openProposals = detail.proposals
    .filter((proposal) => proposal.state === "open")
    .map((proposal) => ({ ...proposal, projectName: project.name }))

  return (
    <div className="ui-page">
      <div className="ui-section">
        <PageHead
          title={project.name}
          titleDir="auto"
          description={
            <p className="ui-project-sub">
              <StageTag stage={project.stage} />
              <span>{tc("project.openCount", openItems.length)}</span>
              {project.githubRepo ? (
                <>
                  <Copyable value={project.githubRepo} />
                  {project.openIssuesCount !== null ? (
                    <a
                      href={issuesUrl(project.githubRepo)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ui-link"
                    >
                      {tc("project.issues", project.openIssuesCount)}
                    </a>
                  ) : null}
                </>
              ) : null}
            </p>
          }
          actions={
            <button type="button" className="ui-btn" onClick={() => setEditing("add")}>
              <Plus aria-hidden="true" />
              {t("project.addItem")}
            </button>
          }
        />
        <StaleNote failed={refreshFailed} />

        <StagePanel project={project} />
        {openProposals.length ? (
          <Panel id="proposals" title={t("project.proposalsTitle")} count={openProposals.length}>
            {openProposals.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} />
            ))}
          </Panel>
        ) : null}

        <Panel
          id="goal"
          title={t("project.goalTitle")}
          extra={
            <button type="button" className="ui-more" onClick={() => setEditing("goal")}>
              {detail.goal ? t("project.changeGoal") : t("project.setGoal")}
            </button>
          }
        >
          {detail.goal ? (
            <div className="ui-panel-body ui-section">
              <p className="ui-text-block" dir="auto">
                {detail.goal.text}
              </p>
              <Progress done={detail.goal.done} total={detail.goal.total} />
            </div>
          ) : (
            <Empty title={t("project.noGoal")} hint={t("project.noGoalHint")} />
          )}
        </Panel>

        <Panel
          id="where"
          title={t("project.whereTitle")}
          extra={
            <button type="button" className="ui-more" onClick={() => setEditing("where")}>
              {t("project.changeWhere")}
            </button>
          }
        >
          {project.whereWeAre ? (
            <div className="ui-panel-body">
              <p className="ui-text-block" dir="auto">
                {project.whereWeAre}
              </p>
            </div>
          ) : (
            <Empty title={t("project.noWhere")} hint={t("project.noWhereHint")} />
          )}
        </Panel>

        <Panel id="items" title={t("project.itemsTitle")} count={openItems.length}>
          {openItems.length === 0 ? <Empty title={t("project.noItems")} hint={t("project.noItemsHint")} /> : null}
          {OPEN_ORDER.map((status) => {
            const group = openItems.filter((item) => item.status === status)
            if (!group.length) return null
            return (
              <div key={status}>
                <div className="ui-group-head">
                  {t(`itemStatus.${status}`)} <span className="ui-count ui-num">{formatNumber(group.length)}</span>
                </div>
                {group.map((item) => (
                  <ItemRow key={item.id} item={item} showProject={false} />
                ))}
              </div>
            )
          })}
          {closedItems.length ? <ClosedFold items={closedItems} /> : null}
        </Panel>

        <ProjectNotes projectId={project.id} />

        <SecuritySourcesPanel sources={detail.securitySources} />
        <DeletePanel project={project} items={detail.items.length} openItems={openItems.length} />
      </div>
      {editing === "goal" ? (
        <GoalDialog project={project} goal={detail.goal?.text ?? null} onClose={() => setEditing(null)} />
      ) : null}
      {editing === "where" ? <WhereDialog project={project} onClose={() => setEditing(null)} /> : null}
      {editing === "add" ? <QuickAdd projectId={project.id} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function ClosedFold({ items }: { items: ItemSummary[] }) {
  const { t } = useI18n()
  return (
    <details className="ui-fold">
      <summary>
        <ChevronRight aria-hidden="true" />
        {t("project.closedItems")} <span className="ui-count ui-num">{formatNumber(items.length)}</span>
      </summary>
      {items.map((item) => (
        <ItemRow key={item.id} item={item} showProject={false} time="closedAt" />
      ))}
    </details>
  )
}

function useProjectChanged(projectId: string) {
  const queryClient = useQueryClient()
  const refresh = useRefreshItems()
  return async (next?: Project) => {
    if (next)
      queryClient.setQueryData<ProjectDetail>(qk.project(projectId), (old) => (old ? { ...old, project: next } : old))
    await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: qk.project(projectId) })])
  }
}

function StagePanel({ project }: { project: Project }) {
  const { t, language } = useI18n()
  const changed = useProjectChanged(project.id)
  const [busy, setBusy] = useState(false)
  const setStage = async (stage: Stage) => {
    if (stage === project.stage || busy) return
    const previous = project.stage
    setBusy(true)
    try {
      const next = await api.updateProject(project.id, { stage })
      await changed(next)
      showToast(t("project.stageSet", { name: project.name, stage: t(`stage.${stage}`) }), "success", {
        action: {
          label: t("common.undo"),
          ariaLabel: t("project.undoStage", { name: project.name }),
          onAction: async () => {
            try {
              await changed(await api.updateProject(project.id, { stage: previous }))
              showToast(t("project.stageBack", { name: project.name }), "success")
            } catch (error) {
              showToast(t("toast.undoFailed", { reason: errorReason(language, error) }), "error")
            }
          },
        },
      })
    } catch (error) {
      showToast(t("project.stageFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel id="stage" title={t("project.stageTitle")}>
      <div className="ui-panel-body ui-section">
        <p className="ui-hint">{t("project.stageHint")}</p>
        <fieldset className="ui-seg ui-plain-fieldset" aria-busy={busy || undefined}>
          <legend className="ui-sr-only">{t("project.stageTitle")}</legend>
          {STAGES.map((stage) => (
            <button
              key={stage}
              type="button"
              aria-pressed={project.stage === stage}
              disabled={busy}
              onClick={() => void setStage(stage)}
            >
              {t(`stage.${stage}`)}
            </button>
          ))}
        </fieldset>
        {project.stage === null ? <p className="ui-hint ui-text-warn">{t("project.stageUnsetHint")}</p> : null}
      </div>
    </Panel>
  )
}

function TextDialog({
  title,
  label,
  hint,
  initial,
  multiline,
  allowEmpty,
  maxLength,
  onSave,
  onClose,
}: {
  title: string
  label: string
  hint: string
  initial: string
  multiline: boolean
  allowEmpty: boolean
  maxLength: number
  onSave: (value: string) => Promise<void>
  onClose: () => void
}) {
  const { t, language } = useI18n()
  const fieldId = useId()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useDiscardGuard(value !== initial && !busy, onClose)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!allowEmpty && !value.trim()) {
      setError(t("project.textRequired", { field: label }))
      return
    }
    setBusy(true)
    try {
      await onSave(value.trim())
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(
        failure instanceof ApiError && failure.code === "secret_suspected"
          ? t("errors.secretSuspected")
          : t("project.saveFailed", { reason: errorReason(language, failure) }),
      )
    }
  }
  return (
    <Dialog
      size="md"
      title={title}
      onClose={() => void close()}
      foot={
        <>
          <button type="button" className="ui-btn" onClick={() => void close()} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form={`${fieldId}-form`}
            className="ui-btn ui-btn-primary"
            disabled={busy || value === initial}
          >
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <form id={`${fieldId}-form`} className="ui-form-stack" onSubmit={submit} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={fieldId}>
            {label}
          </label>
          {multiline ? (
            <textarea
              id={fieldId}
              className="ui-textarea"
              dir="auto"
              rows={4}
              maxLength={maxLength}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              id={fieldId}
              className="ui-input"
              dir="auto"
              maxLength={maxLength}
              value={value}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          {error ? (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="ui-hint">{hint}</p>
          )}
        </div>
      </form>
    </Dialog>
  )
}

function GoalDialog({ project, goal, onClose }: { project: Project; goal: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const changed = useProjectChanged(project.id)
  return (
    <TextDialog
      title={goal ? t("project.changeGoal") : t("project.setGoal")}
      label={t("project.goalLabel")}
      hint={goal ? t("project.goalReplaceHint") : t("project.goalHint")}
      initial={goal ?? ""}
      multiline={false}
      allowEmpty={false}
      maxLength={LIMITS.goal}
      onClose={onClose}
      onSave={async (text) => {
        await changed(await api.updateProject(project.id, { goal: text }))
        showToast(t("project.goalSaved", { name: project.name }), "success")
      }}
    />
  )
}

function WhereDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useI18n()
  const changed = useProjectChanged(project.id)
  return (
    <TextDialog
      title={t("project.changeWhere")}
      label={t("project.whereTitle")}
      hint={t("project.whereHint")}
      initial={project.whereWeAre ?? ""}
      multiline
      allowEmpty
      maxLength={LIMITS.whereWeAre}
      onClose={onClose}
      onSave={async (text) => {
        await changed(await api.updateProject(project.id, { whereWeAre: text || null }))
        showToast(t("project.whereSaved", { name: project.name }), "success")
      }}
    />
  )
}

const COVERAGE_TONE = {
  enabled: "ok",
  not_enabled: "neutral",
  no_access: "warn",
  error: "fail",
  unknown: "neutral",
} as const

/** A source is stale when its as-of time is unknown or older than 26 hours (as the morning view says). */
export function sourceStale(source: SecuritySource, now = Date.now()): boolean {
  return !source.asOf || now - new Date(source.asOf).getTime() > 26 * 3600 * 1000
}

function SecuritySourcesPanel({ sources }: { sources: SecuritySource[] }) {
  const { t } = useI18n()
  return (
    <Panel id="security" title={t("project.securityTitle")} count={sources.length}>
      {sources.length === 0 ? (
        <Empty title={t("project.securityEmpty")} hint={t("project.securityEmptyHint")} />
      ) : (
        <div
          className="ui-table ui-stack"
          style={
            {
              "--ui-cols": "minmax(0, 1.2fr) 130px repeat(4, 64px) minmax(0, 1fr)",
              "--ui-table-min": "720px",
              background: "none",
            } as CSSProperties
          }
        >
          <div className="ui-tr ui-tr-head" aria-hidden="true">
            <span>{t("project.colSource")}</span>
            <span>{t("project.colCoverage")}</span>
            {SEVERITIES.map((severity) => (
              <span key={severity} className="ui-td-end">
                {t(`severity.${severity}`)}
              </span>
            ))}
            <span>{t("project.colAsOf")}</span>
          </div>
          {sources.map((source) => (
            <div key={source.family} className="ui-tr">
              <span className="ui-td ui-td-first">
                <b>{t(`security.family.${source.family}`)}</b>
              </span>
              <span className="ui-td">
                <Tag tone={COVERAGE_TONE[source.coverage]}>{t(`security.coverage.${source.coverage}`)}</Tag>
              </span>
              {SEVERITIES.map((severity) => {
                const count = source[severity]
                const tone =
                  count && severity === "critical" ? "ui-text-fail" : count && severity === "high" ? "ui-text-warn" : ""
                return (
                  <span key={severity} className={`ui-td ui-td-end ${tone}`}>
                    <span className="ui-td-label">{t(`severity.${severity}`)} </span>
                    {source.coverage === "enabled" ? formatNumber(count) : "-"}
                  </span>
                )
              })}
              <span className={source.coverage === "enabled" && sourceStale(source) ? "ui-td ui-text-warn" : "ui-td"}>
                <span className="ui-td-label">{t("project.colAsOf")} </span>
                {source.asOf ? <Time value={source.asOf} /> : t("security.asOfUnknown")}
                {source.coverage === "enabled" && sourceStale(source) ? ` · ${t("security.stale")}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function DeletePanel({ project, items, openItems }: { project: Project; items: number; openItems: number }) {
  const { t, tc, language } = useI18n()
  const navigate = useNavigate()
  const refresh = useRefreshItems()
  const remove = async () => {
    const ok = await confirmDialog({
      title: t("project.deleteTitle", { name: project.name }),
      message: [items ? tc("project.deleteItems", items) : t("project.deleteNoItems"), t("project.deleteForever")].join(
        "\n",
      ),
      confirmText: t("project.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteProject(project.id)
      showToast(t("project.deleted", { name: project.name }), "success")
      await refresh()
      navigate("/projects", { replace: true })
    } catch (error) {
      const reason =
        error instanceof ApiError && error.code === "conflict"
          ? t("project.deleteConflict")
          : errorReason(language, error)
      showToast(t("project.deleteFailed", { name: project.name, reason }), "error")
    }
  }
  return (
    <Panel id="danger" title={t("project.dangerTitle")}>
      <div className="ui-panel-body ui-danger-zone">
        <p>{openItems ? tc("project.deleteHintItems", openItems) : t("project.deleteHint")}</p>
        <button type="button" className="ui-btn ui-btn-danger" onClick={() => void remove()}>
          {t("project.delete")}
        </button>
      </div>
    </Panel>
  )
}

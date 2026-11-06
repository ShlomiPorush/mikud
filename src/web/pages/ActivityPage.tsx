// The audit log: every change by anyone, newest first, loaded by cursor as the end scrolls into view.
// An item entry opens the item; a project or note entry opens its page.
//
// The filter bar (v3 MP-6, TB-17, TB-18, NL-3): the search and Who at every size, Agent, Action and Project behind
// the Filters button, and an item named by a link (the item dialog's "All activity"). The filters live in the
// address under the API's own names, so a reload, Back, Forward and a shared link keep them; a value the API
// would refuse is dropped from the address in place. Every count comes from the server's first page, never from
// the rows loaded; each picker's counts are what choosing that value lists. A change of filters is a new list
// from its first page (its own query key), so an answer for older filters never shows.

import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { AUDIT_FILTER_KEYS, type AuditFilters, auditFilterSchema } from "../../shared/api.ts"
import { ACTOR_KINDS } from "../../shared/enums.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { AuditCounts, AuditEntry } from "../api/types.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { useOpenItem } from "../shell/items.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { FilterBar, SearchBox } from "../ui/FilterBar.tsx"
import { Picker, type PickerOption } from "../ui/Picker.tsx"
import { EVERY, usePageInfiniteQuery, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { ActorTag, Tag } from "../ui/tags.tsx"
import { actionLabel, actionText, changesOf } from "./audit.ts"
import { ListEnd } from "./ListEnd.tsx"
import { Panel } from "./parts.tsx"

type FilterKey = (typeof AUDIT_FILTER_KEYS)[number]
export type PageFilters = Pick<AuditFilters, FilterKey>

/**
 * The filters in the address, each checked as the API checks it; `dropped` names the ones to take out of the
 * address. An agent goes with Who = Agent or Everyone: beside another kind it could list nothing.
 */
export function filtersFromParams(params: URLSearchParams): { filters: PageFilters; dropped: FilterKey[] } {
  const filters: Record<string, string> = {}
  const dropped: FilterKey[] = []
  for (const key of AUDIT_FILTER_KEYS) {
    const raw = params.get(key)
    if (raw === null) continue
    const parsed = auditFilterSchema.shape[key].safeParse(raw)
    if (parsed.success && typeof parsed.data === "string") filters[key] = parsed.data
    else dropped.push(key)
  }
  if (filters.agent && filters.actorKind && filters.actorKind !== "agent") {
    delete filters.agent
    dropped.push("agent")
  }
  return { filters: filters as PageFilters, dropped }
}

const hint = (count: number | undefined) => (count === undefined ? undefined : formatNumber(count))

/**
 * A picker's options, with the chosen value kept when the other filters leave it out (no blank pill): with a count
 * of 0 when the counts are in, and with none while they are not (a failed refresh must not claim 0 beside its rows).
 */
function withChosen(
  options: PickerOption[],
  chosen: string | undefined,
  label: (value: string) => string,
  counted: boolean,
) {
  if (!chosen || options.some((option) => option.value === chosen)) return options
  return [...options, { value: chosen, label: label(chosen), hint: counted ? formatNumber(0) : undefined }]
}

export function ActivityPage() {
  const { t, tc, language } = useI18n()
  usePageMeta(t("activity.title"))
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const { filters, dropped } = filtersFromParams(params)
  const inUse = AUDIT_FILTER_KEYS.some((key) => filters[key] !== undefined)

  // The address holds only what the API takes; a refused value is corrected in place, without a Back step.
  const droppedKey = dropped.join(",")
  useEffect(() => {
    if (!droppedKey) return
    setParams(
      (current) => {
        for (const key of droppedKey.split(",")) current.delete(key)
        return current
      },
      { replace: true },
    )
  }, [droppedKey, setParams])

  /** A filter change: a picker adds a Back step, the search replaces its own (it changes as the owner types). */
  const setFilters = (patch: Partial<Record<FilterKey, string | undefined>>, replace = false) =>
    setParams(
      (current) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value) current.set(key, value)
          else current.delete(key)
        }
        return current
      },
      { replace },
    )

  const request: AuditFilters = { ...filters, ...(filters.q ? { lang: language } : {}) }
  const listKey = JSON.stringify(request)
  const query = usePageInfiniteQuery({
    queryKey: qk.auditFiltered(request),
    queryFn: (cursor) => api.audit(request, cursor),
    every: EVERY.live,
  })
  const projects = usePageQuery({ queryKey: qk.projects, queryFn: api.projects, every: EVERY.live })
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? []
  const unique = entries.filter((entry, index) => entries.findIndex((other) => other.id === entry.id) === index)
  // A failed refresh shows no counts: the stale note says the list may be old (TB-18).
  const first = query.isRefetchError ? undefined : query.data?.pages[0]
  const counts = first?.counts ?? null
  const total = first?.total ?? null

  const options = useFilterOptions(counts, filters, projects.data ?? [])
  const more = [filters.agent, filters.action, filters.projectId].filter(Boolean).length

  return (
    <div className="ui-page">
      <div className="ui-section">
        <PageHead title={t("activity.title")} description={t("activity.description")} />
        <StaleNote failed={query.isRefetchError} />
        <FilterBar
          listKey={listKey}
          loading={query.isPending}
          search={
            <SearchBox
              value={filters.q ?? ""}
              resetKey={location.key}
              label={t("activity.search")}
              placeholder={t("activity.searchPlaceholder")}
              onChange={(text) => setFilters({ q: text.trim() || undefined }, true)}
            />
          }
          pickers={
            <>
              <Picker
                label={t("activity.who")}
                value={filters.actorKind ?? ""}
                defaultValue=""
                options={options.who}
                // A kind replaces the agent: the counts of Who ignore both (docs/api.md, Audit filters).
                onChange={(value) => setFilters({ actorKind: value || undefined, agent: undefined })}
              />
              {filters.itemId ? (
                <ItemFilter itemId={filters.itemId} onRemove={() => setFilters({ itemId: undefined })} />
              ) : null}
            </>
          }
          more={
            <>
              {!filters.actorKind || filters.actorKind === "agent" ? (
                <Picker
                  label={t("activity.agent")}
                  value={filters.agent ?? ""}
                  defaultValue=""
                  options={options.agents}
                  onChange={(value) => setFilters({ agent: value || undefined })}
                />
              ) : null}
              <Picker
                label={t("activity.action")}
                value={filters.action ?? ""}
                defaultValue=""
                options={options.actions}
                onChange={(value) => setFilters({ action: value || undefined })}
              />
              <Picker
                label={t("activity.project")}
                value={filters.projectId ?? ""}
                defaultValue=""
                options={options.projects}
                searchLabel={t("picker.searchProjects")}
                onChange={(value) => setFilters({ projectId: value || undefined })}
              />
            </>
          }
          active={more}
          count={query.isPending ? t("activity.counting") : total !== null ? tc("activity.count", total) : undefined}
          onClear={
            inUse ? () => setFilters(Object.fromEntries(AUDIT_FILTER_KEYS.map((key) => [key, undefined]))) : undefined
          }
        />
        {query.isPending ? <Loading label={t("activity.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("activity.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <Panel id="activity" title={t("activity.listTitle")}>
            {unique.length === 0 ? (
              inUse ? (
                <Empty
                  title={
                    filters.q && AUDIT_FILTER_KEYS.every((key) => key === "q" || filters[key] === undefined)
                      ? t("activity.noMatchSearch", { q: filters.q })
                      : t("activity.noMatch")
                  }
                  hint={t("activity.noMatchHint")}
                />
              ) : (
                <Empty title={t("activity.empty")} hint={t("activity.emptyHint")} />
              )
            ) : (
              <>
                {unique.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
                <ListEnd
                  hasMore={!!query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  failed={query.isFetchNextPageError}
                  shown={unique.length}
                  onMore={() => void query.fetchNextPage()}
                  allShownKey="activity.allShown"
                />
              </>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

/** Each picker's options with the server's counts (none while they are unknown). */
function useFilterOptions(
  counts: AuditCounts | null,
  filters: PageFilters,
  projectList: { id: string; name: string }[],
): Record<"who" | "agents" | "actions" | "projects", PickerOption[]> {
  const { t, language } = useI18n()
  const everyone = counts ? Object.values(counts.actorKind).reduce((sum, count) => sum + count, 0) : undefined
  const who: PickerOption[] = [
    { value: "", label: t("activity.everyone"), hint: hint(everyone) },
    ...ACTOR_KINDS.map((kind) => ({
      value: kind,
      label: t(`activity.actorKind.${kind}`),
      hint: hint(counts?.actorKind[kind]),
    })),
  ]
  const agents = withChosen(
    [
      { value: "", label: t("activity.allAgents") },
      ...(counts?.agents ?? []).map((agent) => ({ value: agent.label, label: agent.label, hint: hint(agent.count) })),
    ],
    filters.agent,
    (label) => label,
    Boolean(counts),
  )
  const actions = withChosen(
    [
      { value: "", label: t("activity.allActions") },
      ...(counts?.actions ?? []).map((action) => ({
        value: action.action,
        label: actionLabel(language, action.action),
        search: action.action,
        hint: hint(action.count),
      })),
    ],
    filters.action,
    (code) => actionLabel(language, code),
    Boolean(counts),
  )
  // Every project the owner has, then rows of projects deleted since; a count of 0 where none match.
  const projectCount = new Map((counts?.projects ?? []).map((entry) => [entry.projectId, entry.count]))
  const known = new Set(projectList.map((project) => project.id))
  const named = [...projectList]
    .sort((a, b) => a.name.localeCompare(b.name, language))
    .map((project) => ({
      value: project.id,
      label: project.name,
      hint: counts ? formatNumber(projectCount.get(project.id) ?? 0) : undefined,
    }))
  const deleted = (counts?.projects ?? [])
    .filter((entry) => !known.has(entry.projectId))
    .map((entry) => ({ value: entry.projectId, label: t("activity.deletedProject"), hint: hint(entry.count) }))
  const projects = withChosen(
    [{ value: "", label: t("activity.allProjects") }, ...named, ...deleted],
    filters.projectId,
    () => t("activity.deletedProject"),
    Boolean(counts),
  )
  return { who, agents, actions, projects }
}

/** The item a link narrowed the list to, named by its title, with a button that removes it. */
function ItemFilter({ itemId, onRemove }: { itemId: string; onRemove: () => void }) {
  const { t } = useI18n()
  const item = useQuery({ queryKey: qk.item(itemId), queryFn: () => api.item(itemId), retry: false })
  const gone = item.error instanceof ApiError && item.error.code === "not_found"
  const title = item.data?.item.title ?? (gone ? t("activity.deletedItem") : "")
  return (
    <button
      type="button"
      className="ui-picker-pill ui-fbar-tag"
      data-set=""
      aria-label={t("activity.removeItem", { title })}
      title={t("activity.removeItem", { title })}
      onClick={onRemove}
    >
      <span className="ui-picker-name">{t("activity.item")}:</span>
      <span className="ui-picker-value">
        <bdi dir="auto">{title}</bdi>
      </span>
      <span aria-hidden="true" className="ui-fbar-tag-x">
        ×
      </span>
    </button>
  )
}

/** The name of what changed, from the entry itself: an item title or a project name. */
function entityLabel(entry: AuditEntry): string | null {
  for (const side of [entry.after, entry.before]) {
    for (const field of ["title", "name", "label"]) {
      const value = side?.[field]
      if (typeof value === "string" && value.trim()) return value
    }
  }
  return null
}

function EntityLink({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n()
  const openItem = useOpenItem()
  const label = entityLabel(entry) ?? t(`audit.entity.${entry.entityType}`)
  const gone = entry.action.endsWith(".delete")
  if (entry.entityType === "item" && !gone) {
    return (
      <button type="button" className="ui-row-title" dir="auto" onClick={() => openItem(entry.entityId)}>
        {label}
      </button>
    )
  }
  if (entry.entityType === "note" && !gone) {
    return (
      <Link to={`/notes/${entry.entityId}`} className="ui-row-title" dir="auto">
        {label}
      </Link>
    )
  }
  if (entry.entityType === "project" && !gone) {
    return (
      <Link to={`/projects/${entry.entityId}`} className="ui-row-title" dir="auto">
        {label}
      </Link>
    )
  }
  return (
    <b className="ui-user" dir="auto">
      {label}
    </b>
  )
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const { t, language } = useI18n()
  const changes = changesOf(language, entry)
  return (
    <div className="ui-item">
      <div className="ui-item-main">
        <EntityLink entry={entry} />
        <span className="ui-item-meta">
          <ActorTag kind={entry.actorKind} label={entry.actorLabel} />
          <span>{actionText(language, entry)}</span>
          {changes.map((change) => (
            <span key={change.field} className="ui-change">
              {change.field}: <bdi dir="auto">{change.before}</bdi> {t("common.arrow")}{" "}
              <bdi dir="auto">{change.after}</bdi>
            </span>
          ))}
        </span>
      </div>
      <div className="ui-item-end">
        <Tag tone="neutral" line>
          {t(`audit.source.${entry.source}`)}
        </Tag>
        <Time value={entry.at} />
      </div>
    </div>
  )
}

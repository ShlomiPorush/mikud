// Notes: knowledge the owner and his agents keep (requirements section 10). A list newest change first,
// loaded by cursor as its end scrolls into view; a row opens the note's own page.
//
// The filters live in the address under the API's names (v3 NL-3), so a reload, Back and a shared link keep
// them: the search, the project (or the general notes, `general=true`), who created the note, and the order
// of the one Sort button (TB-28). A change of filters is a new list from its first page (its own query key).

import { Plus } from "lucide-react"
import { useEffect } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router"
import { z } from "zod"
import { ACTOR_KINDS, type ActorKind } from "../../shared/enums.ts"
import { api, qk } from "../api/endpoints.ts"
import { NOTE_SORTS, type NoteFilters, type NoteOrder, type NoteSort, type NoteSummary } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageActions, PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { FilterBar, SearchBox } from "../ui/FilterBar.tsx"
import { Picker, type PickerOption } from "../ui/Picker.tsx"
import { EVERY, usePageInfiniteQuery, usePageQuery } from "../ui/refresh.ts"
import { SortButton, type SortColumn, type SortState } from "../ui/SortButton.tsx"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { ActorTag } from "../ui/tags.tsx"
import { ListEnd } from "./ListEnd.tsx"
import { Panel, selecting } from "./parts.tsx"

/** Who may have created a note: the owner, an agent or the Telegram bot. */
const CREATORS = ACTOR_KINDS.filter((kind): kind is ActorKind => kind === "owner" || kind === "agent" || kind === "bot")
const DEFAULT_SORT: SortState<NoteSort> = { key: "updated", dir: "desc" }
/** The project filter's value for notes without a project. */
const GENERAL = "general"

const uuid = z.uuid()

/** The filters in the address, each checked; anything the API would refuse is left out (and dropped in place). */
export function noteFiltersFromParams(params: URLSearchParams): { filters: NoteFilters; dropped: string[] } {
  const filters: NoteFilters = {}
  const dropped: string[] = []
  const q = params.get("q")?.trim()
  if (q) filters.q = q.slice(0, 200)
  const projectId = params.get("projectId")
  if (projectId !== null) {
    if (uuid.safeParse(projectId).success) filters.projectId = projectId.toLowerCase()
    else dropped.push("projectId")
  }
  const general = params.get("general")
  if (general !== null) {
    if (general === "true" && !filters.projectId) filters.general = true
    else dropped.push("general")
  }
  const createdBy = params.get("createdBy")
  if (createdBy !== null) {
    if ((CREATORS as readonly string[]).includes(createdBy)) filters.createdBy = createdBy as ActorKind
    else dropped.push("createdBy")
  }
  const sort = params.get("sort")
  if (sort !== null) {
    if ((NOTE_SORTS as readonly string[]).includes(sort)) filters.sort = sort as NoteSort
    else dropped.push("sort")
  }
  const order = params.get("order")
  if (order !== null) {
    if (order === "asc" || order === "desc") filters.order = order
    else dropped.push("order")
  }
  return { filters, dropped }
}

/** The order in effect: the address's, else the sort's first order (newest change first, titles A to Z). */
function sortOf(filters: NoteFilters): SortState<NoteSort> {
  const key = filters.sort ?? DEFAULT_SORT.key
  const dir: NoteOrder = filters.order ?? (key === "title" ? "asc" : "desc")
  return { key, dir }
}

export function NotesPage() {
  const { t } = useI18n()
  usePageMeta(t("notes.title"))
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const { filters, dropped } = noteFiltersFromParams(params)

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
  const setFilters = (patch: Record<string, string | undefined>, replace = false) =>
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

  const sort = sortOf(filters)
  const request: NoteFilters = { ...filters, sort: sort.key, order: sort.dir }
  const query = usePageInfiniteQuery({
    queryKey: qk.notesFiltered(request),
    queryFn: (cursor) => api.notes(request, cursor),
    every: EVERY.live,
  })
  const projects = usePageQuery({ queryKey: qk.projects, queryFn: api.projects, every: EVERY.live })
  const names = new Map((projects.data ?? []).map((project) => [project.id, project.name]))
  const notes = query.data?.pages.flatMap((page) => page.entries) ?? []
  const unique = notes.filter((note, index) => notes.findIndex((other) => other.id === note.id) === index)

  const projectValue = filters.general ? GENERAL : (filters.projectId ?? "")
  const projectOptions: PickerOption[] = [
    { value: "", label: t("notes.allProjects") },
    { value: GENERAL, label: t("notes.general") },
    ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
  ]
  const creatorOptions: PickerOption[] = [
    { value: "", label: t("notes.everyone") },
    ...CREATORS.map((kind) => ({ value: kind, label: t(`activity.actorKind.${kind}`) })),
  ]
  const columns: SortColumn<NoteSort>[] = [
    { key: "updated", label: t("notes.sortUpdated"), kind: "date" },
    { key: "title", label: t("notes.sortTitle"), kind: "text" },
  ]
  const inUse = !!(filters.q || filters.projectId || filters.general || filters.createdBy)
  const newHref = filters.projectId ? `/notes/new?projectId=${encodeURIComponent(filters.projectId)}` : "/notes/new"

  return (
    <div className="ui-page">
      <div className="ui-section">
        <PageHead title={t("notes.title")} description={t("notes.description")} />
        <PageActions>
          <Link className="ui-btn ui-btn-primary" to={newHref}>
            <Plus aria-hidden="true" />
            {t("notes.new")}
          </Link>
        </PageActions>
        <StaleNote failed={query.isRefetchError} />
        <FilterBar
          listKey={JSON.stringify(request)}
          loading={query.isPending}
          search={
            <SearchBox
              value={filters.q ?? ""}
              resetKey={location.key}
              label={t("notes.search")}
              placeholder={t("notes.searchPlaceholder")}
              onChange={(text) => setFilters({ q: text.trim() || undefined }, true)}
            />
          }
          pickers={
            <>
              <Picker
                label={t("notes.project")}
                value={projectValue}
                defaultValue=""
                options={projectOptions}
                searchLabel={t("picker.searchProjects")}
                onChange={(value) =>
                  setFilters({
                    projectId: value && value !== GENERAL ? value : undefined,
                    general: value === GENERAL ? "true" : undefined,
                  })
                }
              />
              <Picker
                label={t("notes.createdBy")}
                value={filters.createdBy ?? ""}
                defaultValue=""
                options={creatorOptions}
                onChange={(value) => setFilters({ createdBy: value || undefined })}
              />
            </>
          }
          count={
            <SortButton
              name={t("notes.sortName")}
              columns={columns}
              value={sort}
              defaultValue={DEFAULT_SORT}
              onChange={(next) =>
                setFilters({
                  sort: next.key === DEFAULT_SORT.key ? undefined : next.key,
                  order: next.dir === (next.key === "title" ? "asc" : "desc") ? undefined : next.dir,
                })
              }
            />
          }
          onClear={
            inUse
              ? () => setFilters({ q: undefined, projectId: undefined, general: undefined, createdBy: undefined })
              : undefined
          }
        />
        {query.isPending ? <Loading label={t("notes.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("notes.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <Panel id="notes" title={t("notes.listTitle")}>
            {unique.length === 0 ? (
              inUse ? (
                <Empty title={t("notes.noMatch")} hint={t("notes.noMatchHint")} />
              ) : (
                <Empty title={t("notes.empty")} hint={t("notes.emptyHint")} />
              )
            ) : (
              <>
                {unique.map((note) => (
                  <NoteRow key={note.id} note={note} projectName={note.projectId ? names.get(note.projectId) : null} />
                ))}
                <ListEnd
                  hasMore={!!query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  failed={query.isFetchNextPageError}
                  shown={unique.length}
                  onMore={() => void query.fetchNextPage()}
                  allShownKey="notes.allShown"
                />
              </>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

/** A note in a list: a link to its page (a click that ends a text selection opens nothing, TB-8). */
export function NoteRow({
  note,
  projectName,
  showProject = true,
}: {
  note: NoteSummary
  projectName?: string | null
  showProject?: boolean
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  return (
    <Link
      className="ui-item ui-note-row"
      data-row-open=""
      to={`/notes/${note.id}`}
      onClick={(event) => {
        if (selecting(event)) event.preventDefault()
        else if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
          event.preventDefault()
          navigate(`/notes/${note.id}`)
        }
      }}
    >
      <div className="ui-item-main">
        <span className="ui-item-title" dir="auto" title={note.title}>
          {note.title}
        </span>
        {note.excerpt ? (
          <span className="ui-note-excerpt" dir="auto">
            {note.excerpt}
          </span>
        ) : null}
        <span className="ui-item-meta">
          {showProject ? (
            note.projectId ? (
              <bdi dir="auto">{projectName ?? t("notes.unknownProject")}</bdi>
            ) : (
              <span>{t("notes.generalNote")}</span>
            )
          ) : null}
          <ActorTag kind={note.updatedBy} label={note.updatedByLabel ?? note.updatedBy} />
        </span>
      </div>
      <div className="ui-item-end">
        <Time value={note.updatedAt} />
      </div>
    </Link>
  )
}

const PROJECT_NOTES = 10

/** A project's notes on its page: the latest changed, with a link to all of them and to a new one. */
export function ProjectNotes({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const filters: NoteFilters = { projectId, sort: "updated", order: "desc" }
  const query = usePageQuery({
    queryKey: [...qk.notesFiltered(filters), "first"],
    queryFn: () => api.notes(filters, null),
    every: EVERY.live,
  })
  const notes = query.data?.entries ?? []
  const more = !!query.data?.nextCursor || notes.length > PROJECT_NOTES
  return (
    <Panel
      id="project-notes"
      title={t("notes.projectTitle")}
      extra={
        <span className="ui-panel-links">
          <Link className="ui-link" to={`/notes/new?projectId=${encodeURIComponent(projectId)}`}>
            {t("notes.new")}
          </Link>
          {notes.length ? (
            <Link className="ui-link" to={`/notes?projectId=${encodeURIComponent(projectId)}`}>
              {more ? t("notes.allOfProject") : t("notes.openList")}
            </Link>
          ) : null}
        </span>
      }
    >
      {query.isPending ? <Loading label={t("notes.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("notes.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && notes.length === 0 ? (
        <Empty title={t("notes.projectEmpty")} hint={t("notes.projectEmptyHint")} />
      ) : null}
      {notes.slice(0, PROJECT_NOTES).map((note) => (
        <NoteRow key={note.id} note={note} showProject={false} />
      ))}
    </Panel>
  )
}

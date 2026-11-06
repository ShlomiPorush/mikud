// One note on its own page (/notes/:noteId), and a new one (/notes/new, with ?projectId= to start in a project).
// Requirements section 10.
//
// The title, the project and the Markdown body are editable at once, with no Edit mode, and saved on purpose
// through the page's save bar (v3 SV-1); leaving with unsaved changes asks first (unsaved.tsx). Write shows the
// text and Preview the rendered Markdown. A draft keeps the version the typing started on (draft.ts): a change
// an agent saved meanwhile answers version_conflict, the draft stays, and the page says so (Reload, or save
// again over it knowingly: the agent's text stays a version that can be restored). A background refresh never
// replaces what is typed (SV-6). While a save is on its way the fields are read only, so nothing typed then is
// dropped with the saved draft (result review R4).
//
// The versions list under the note opens any version in a dialog with its rendered text; Restore makes it the
// newest version (the server keeps the current one), so it acts at once and offers Undo (FB-16). Delete asks
// first: it removes the note with all its versions.

import { useQueryClient } from "@tanstack/react-query"
import { History, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { LIMITS } from "../../shared/api.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { Note, NoteDetail, NoteVersionSummary } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageActions, PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Markdown } from "../ui/Markdown.tsx"
import { Picker, type PickerOption } from "../ui/Picker.tsx"
import { EVERY, usePageInfiniteQuery, usePageQuery } from "../ui/refresh.ts"
import { SaveBar } from "../ui/SaveBar.tsx"
import { Banner, Empty, ErrorState, errorReason, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast, UNDO_MS } from "../ui/Toast.tsx"
import { ActorTag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { draftBase, saveVersion } from "./draft.ts"
import { ListEnd } from "./ListEnd.tsx"
import { Panel, rowKeys, selecting } from "./parts.tsx"

/** The project picker's value for a note without a project. */
const GENERAL = ""

export function NotePage() {
  const { noteId = "" } = useParams()
  // A new note and each note are separate editors: moving between them never carries a draft along.
  return noteId === "new" ? <NoteEditor key="new" noteId={null} /> : <NoteEditor key={noteId} noteId={noteId} />
}

function NoteEditor({ noteId }: { noteId: string | null }) {
  const { t, language } = useI18n()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const query = usePageQuery({
    queryKey: qk.note(noteId ?? "new"),
    queryFn: () => api.note(noteId ?? ""),
    every: EVERY.live,
    enabled: noteId !== null,
  })
  const projects = usePageQuery({ queryKey: qk.projects, queryFn: api.projects, every: EVERY.live })
  const note = query.data?.note ?? null
  const startProject = noteId === null ? (params.get("projectId") ?? GENERAL) : GENERAL

  // The draft: null is "as loaded". The base version is pinned when the typing starts (draft.ts).
  const [title, setTitle] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [baseVersion, setBaseVersion] = useState<number | null>(null)
  const [conflict, setConflict] = useState(false)
  const [tab, setTab] = useState<"write" | "preview">(noteId === null ? "write" : "preview")
  const [busy, setBusy] = useState(false)
  const [openVersion, setOpenVersion] = useState<number | null>(null)
  const leaving = useRef(false)

  const loaded = {
    title: note?.title ?? "",
    body: note?.body ?? "",
    projectId: note ? (note.projectId ?? GENERAL) : startProject,
  }
  const shown = {
    title: title ?? loaded.title,
    body: body ?? loaded.body,
    projectId: projectId ?? loaded.projectId,
  }
  const titleDirty = title !== null && title !== loaded.title
  const bodyDirty = body !== null && body !== loaded.body
  const projectDirty = projectId !== null && projectId !== loaded.projectId
  const count = (titleDirty ? 1 : 0) + (bodyDirty ? 1 : 0) + (projectDirty ? 1 : 0)
  useUnsaved("note-page", { count, kind: "leave", keeps: () => leaving.current })

  const startDraft = () => {
    if (note) setBaseVersion((base) => draftBase(base, note.version))
  }
  const dropDraft = () => {
    setTitle(null)
    setBody(null)
    setProjectId(null)
    setBaseVersion(null)
    setConflict(false)
  }
  const refreshLists = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.notes })
    await queryClient.invalidateQueries({ queryKey: qk.morning })
    await queryClient.invalidateQueries({ queryKey: qk.audit })
  }

  const save = async () => {
    if (!shown.title.trim()) {
      showToast(t("notes.titleRequired"), "error")
      document.getElementById("note-title-field")?.focus()
      return
    }
    setBusy(true)
    try {
      if (!note) {
        const created = await api.createNote({
          title: shown.title.trim(),
          body: shown.body,
          projectId: shown.projectId || null,
        })
        leaving.current = true
        dropDraft()
        await refreshLists()
        showToast(t("notes.created", { title: created.title }), "success")
        navigate(`/notes/${created.id}`, { replace: true })
        return
      }
      const patch: { title?: string; body?: string; projectId?: string | null } = {}
      if (titleDirty) patch.title = shown.title.trim()
      if (bodyDirty) patch.body = shown.body
      if (projectDirty) patch.projectId = shown.projectId || null
      const next = await api.updateNote(note.id, saveVersion(baseVersion, note.version), patch)
      queryClient.setQueryData<NoteDetail>(qk.note(note.id), (old) =>
        old ? { note: next, project: projectOf(next.projectId) } : old,
      )
      dropDraft()
      await queryClient.invalidateQueries({ queryKey: qk.noteVersions(note.id) })
      await refreshLists()
      showToast(t("notes.saved", { title: next.title }), "success")
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict" && note) {
        // The draft stays; the note underneath is read again and the page says so.
        await queryClient.invalidateQueries({ queryKey: qk.note(note.id) })
        await queryClient.invalidateQueries({ queryKey: qk.noteVersions(note.id) })
        const current = queryClient.getQueryData<NoteDetail>(qk.note(note.id))?.note.version ?? null
        setConflict(true)
        setBaseVersion(current)
      } else if (error instanceof ApiError && error.code === "secret_suspected") {
        showToast(t("errors.secretSuspected"), "error")
      } else {
        showToast(t("notes.saveFailed", { reason: errorReason(language, error) }), "error")
      }
    } finally {
      setBusy(false)
    }
  }

  const projectOf = (id: string | null) => {
    const project = projects.data?.find((entry) => entry.id === id)
    return project ? { id: project.id, name: project.name } : null
  }

  const remove = async () => {
    if (!note) return
    const ok = await confirmDialog({
      title: t("notes.deleteTitle", { title: note.title }),
      message: t("notes.deleteMessage"),
      confirmText: t("notes.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteNote(note.id, note.version)
      leaving.current = true
      queryClient.removeQueries({ queryKey: qk.note(note.id) })
      await refreshLists()
      showToast(t("notes.deleted", { title: note.title }), "success")
      navigate("/notes")
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: qk.note(note.id) })
        showToast(t("notes.deleteChanged"), "warning")
      } else {
        showToast(t("notes.deleteFailed", { reason: errorReason(language, error) }), "error")
      }
    }
  }

  /** Makes `fromVersion` the newest version; Undo makes the version it replaced the newest again. */
  const restore = async (current: Note, fromVersion: number, undo = true) => {
    try {
      const next = await api.restoreNote(current.id, current.version, fromVersion)
      queryClient.setQueryData<NoteDetail>(qk.note(current.id), (old) =>
        old ? { note: next, project: projectOf(next.projectId) } : old,
      )
      setOpenVersion(null)
      await queryClient.invalidateQueries({ queryKey: qk.noteVersions(current.id) })
      await refreshLists()
      showToast(
        t("notes.restored", { from: fromVersion, version: next.version }),
        "success",
        undo
          ? {
              duration: UNDO_MS,
              action: { label: t("common.undo"), onAction: () => restore(next, current.version, false) },
            }
          : {},
      )
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: qk.note(current.id) })
        await queryClient.invalidateQueries({ queryKey: qk.noteVersions(current.id) })
        showToast(t("notes.restoreChanged"), "warning")
      } else if (error instanceof ApiError && error.code === "conflict") {
        showToast(t("notes.restoreProjectGone"), "error")
      } else {
        showToast(t("notes.restoreFailed", { reason: errorReason(language, error) }), "error")
      }
    }
  }

  const pageTitle = note?.title ?? (noteId === null ? t("notes.newTitle") : t("notes.loadingTitle"))
  usePageMeta(pageTitle, [{ label: t("notes.title"), to: "/notes" }])

  if (noteId !== null && !note) {
    return (
      <div className="ui-page">
        <div className="ui-section">
          <PageHead title={pageTitle} />
          {query.isPending ? <Loading label={t("notes.loadingNote")} /> : null}
          {query.isError ? (
            query.error instanceof ApiError && query.error.code === "not_found" ? (
              <div className="ui-panel">
                <Empty title={t("notes.notFound")} hint={t("notes.notFoundHint")} />
                <div className="ui-panel-body">
                  <Link className="ui-btn" to="/notes">
                    {t("notes.backToNotes")}
                  </Link>
                </div>
              </div>
            ) : (
              <ErrorState title={t("notes.noteFailed")} error={query.error} onRetry={() => void query.refetch()} />
            )
          ) : null}
        </div>
      </div>
    )
  }

  const projectOptions: PickerOption[] = [
    { value: GENERAL, label: t("notes.generalNote") },
    ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
  ]
  const projectName = query.data?.project?.name
  const description = note ? (
    <p className="ui-page-desc">
      {note.projectId ? <bdi dir="auto">{projectName ?? t("notes.unknownProject")}</bdi> : t("notes.generalNote")}
      {" · "}
      {t("notes.versionOf", { version: note.version })}
      {" · "}
      {t("notes.changedBy")} <ActorTag kind={note.updatedBy} label={note.updatedByLabel ?? note.updatedBy} />{" "}
      <Time value={note.updatedAt} />
    </p>
  ) : (
    t("notes.newDescription")
  )

  return (
    <div className="ui-page ui-note-page">
      <div className="ui-section">
        <PageHead title={pageTitle} titleDir={note ? "auto" : undefined} description={description} />
        {note ? (
          <PageActions>
            <button type="button" className="ui-btn ui-btn-danger" onClick={() => void remove()}>
              <Trash2 aria-hidden="true" />
              {t("notes.delete")}
            </button>
          </PageActions>
        ) : null}
        <StaleNote failed={query.isRefetchError} />
        {conflict && count > 0 ? (
          <Banner
            tone="warn"
            title={t("notes.conflictTitle")}
            action={
              <button type="button" className="ui-btn" onClick={dropDraft}>
                {t("notes.conflictReload")}
              </button>
            }
          >
            {t("notes.conflictBody")}
          </Banner>
        ) : null}
        <Panel id="note" title={t("notes.noteTitle")}>
          <div className="ui-panel-body ui-section">
            <div className="ui-note-fields">
              <label className="ui-field">
                <span>{t("notes.titleLabel")}</span>
                <input
                  id="note-title-field"
                  className="ui-input"
                  dir="auto"
                  maxLength={LIMITS.noteTitle}
                  readOnly={busy}
                  value={shown.title}
                  onChange={(event) => {
                    startDraft()
                    setTitle(event.target.value)
                  }}
                />
              </label>
              <div className="ui-field">
                <span id="note-project-label">{t("notes.project")}</span>
                <Picker
                  variant="field"
                  labelledBy="note-project-label"
                  disabled={busy}
                  label={t("notes.project")}
                  value={shown.projectId}
                  options={projectOptions}
                  searchLabel={t("picker.searchProjects")}
                  onChange={(value) => {
                    startDraft()
                    setProjectId(value)
                  }}
                />
              </div>
            </div>
            <fieldset className="ui-seg ui-plain-fieldset">
              <legend className="ui-sr-only">{t("notes.view")}</legend>
              <button type="button" aria-pressed={tab === "write"} onClick={() => setTab("write")}>
                {t("notes.write")}
              </button>
              <button type="button" aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>
                {t("notes.preview")}
              </button>
            </fieldset>
            {tab === "write" ? (
              <label className="ui-field">
                <span className="ui-sr-only">{t("notes.bodyLabel")}</span>
                <textarea
                  id="note-body"
                  className="ui-textarea ui-note-body"
                  dir="auto"
                  maxLength={LIMITS.noteBody}
                  readOnly={busy}
                  placeholder={t("notes.bodyPlaceholder")}
                  value={shown.body}
                  onChange={(event) => {
                    startDraft()
                    setBody(event.target.value)
                  }}
                />
                <span className="ui-hint">{t("notes.markdownHint")}</span>
              </label>
            ) : shown.body.trim() ? (
              <Markdown text={shown.body} />
            ) : (
              <Empty title={t("notes.emptyBody")} hint={t("notes.emptyBodyHint")} />
            )}
          </div>
        </Panel>
        {note ? <Versions note={note} onOpen={setOpenVersion} /> : null}
      </div>
      {note && openVersion !== null ? (
        <VersionDialog
          note={note}
          version={openVersion}
          unsaved={count > 0}
          onRestore={() => void restore(note, openVersion)}
          onClose={() => setOpenVersion(null)}
        />
      ) : null}
      <SaveBar count={count} busy={busy} onSave={() => void save()} onDiscard={dropDraft} />
    </div>
  )
}

/** The note's versions, newest first; a row opens the version. */
function Versions({ note, onOpen }: { note: Note; onOpen: (version: number) => void }) {
  const { t } = useI18n()
  const query = usePageInfiniteQuery({
    queryKey: qk.noteVersions(note.id),
    queryFn: (cursor) => api.noteVersions(note.id, cursor),
    every: EVERY.live,
  })
  const rows = query.data?.pages.flatMap((page) => page.entries) ?? []
  const unique = rows.filter((row, index) => rows.findIndex((other) => other.version === row.version) === index)
  return (
    <Panel id="note-versions" title={t("notes.versionsTitle")} count={note.version}>
      {query.isPending ? <Loading label={t("notes.versionsLoading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("notes.versionsFailed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {unique.map((row) => (
        <VersionRow key={row.version} row={row} current={row.version === note.version} onOpen={onOpen} />
      ))}
      {query.data ? (
        <ListEnd
          hasMore={!!query.hasNextPage}
          loading={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          shown={unique.length}
          onMore={() => void query.fetchNextPage()}
          allShownKey="notes.allVersionsShown"
        />
      ) : null}
    </Panel>
  )
}

function VersionRow({
  row,
  current,
  onOpen,
}: {
  row: NoteVersionSummary
  current: boolean
  onOpen: (version: number) => void
}) {
  const { t } = useI18n()
  const open = () => onOpen(row.version)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content, so it cannot be a <button>
    <div
      className="ui-item"
      data-row-open=""
      role="button"
      tabIndex={0}
      aria-label={t("notes.openVersion", { version: row.version })}
      onClick={(event) => {
        if (!selecting(event)) open()
      }}
      onKeyDown={rowKeys(open)}
    >
      <div className="ui-item-main">
        <span className="ui-item-title">
          <History aria-hidden="true" className="ui-inline-icon" /> {t("notes.versionN", { version: row.version })}
          {current ? <span className="ui-muted"> · {t("notes.current")}</span> : null}
        </span>
        <span className="ui-item-meta">
          <ActorTag kind={row.authorKind} label={row.authorLabel ?? row.authorKind} />
          {row.restoredFrom !== null ? <span>{t("notes.restoredFrom", { version: row.restoredFrom })}</span> : null}
          <span dir="auto" title={row.title}>
            {row.title}
          </span>
        </span>
      </div>
      <div className="ui-item-end">
        <Time value={row.createdAt} />
      </div>
    </div>
  )
}

/** One version with its rendered text, and Restore unless it is the current one. */
function VersionDialog({
  note,
  version,
  unsaved,
  onRestore,
  onClose,
}: {
  note: Note
  version: number
  unsaved: boolean
  onRestore: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const query = usePageQuery({
    queryKey: qk.noteVersion(note.id, version),
    queryFn: () => api.noteVersion(note.id, version),
    every: EVERY.slow,
  })
  const current = version === note.version
  const data = query.data
  return (
    <Dialog
      size="wide"
      title={t("notes.versionDialogTitle", { version })}
      onClose={onClose}
      backdropClose
      foot={
        <>
          {!current ? (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={unsaved || !data}
              title={unsaved ? t("notes.restoreUnsaved") : undefined}
              onClick={onRestore}
            >
              {t("notes.restore")}
            </button>
          ) : null}
          <button type="button" className="ui-btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </>
      }
    >
      {query.isPending ? <Loading label={t("notes.versionLoading")} /> : null}
      {query.isError ? <ErrorState title={t("notes.versionFailed")} error={query.error} /> : null}
      {data ? (
        <div className="ui-section">
          <p className="ui-hint">
            <ActorTag kind={data.authorKind} label={data.authorLabel ?? data.authorKind} />{" "}
            <Time value={data.createdAt} mode="full" />
            {current ? ` · ${t("notes.current")}` : null}
          </p>
          {unsaved && !current ? <p className="ui-hint ui-text-warn">{t("notes.restoreUnsaved")}</p> : null}
          <h3 dir="auto" className="ui-note-version-title">
            {data.title}
          </h3>
          {data.body.trim() ? <Markdown text={data.body} /> : <Empty title={t("notes.emptyBody")} />}
        </div>
      ) : null}
    </Dialog>
  )
}

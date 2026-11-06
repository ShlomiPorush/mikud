// An item, opened as a dialog over the current page (a sheet on phones) with its own address
// (?item=<id>). Status, type, severity, project and goal act at once (status, type and project offer
// Undo). Title, body and a new comment are typed: the foot's Save changes sends the title and body,
// and closing, Escape, Back or a link asks before dropping anything typed (v3 DS-9, SV-1). A save sends
// the version the typing started on (draft.ts): a change made meanwhile is a conflict, never overwritten.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { LIMITS } from "../../shared/api.ts"
import { ITEM_STATUSES, ITEM_TYPES, SEVERITIES, type Severity } from "../../shared/enums.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { Item, ItemDetail } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ITEM_PARAM, useCloseItem, useItemActions, useRefreshItems } from "../shell/items.ts"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Picker } from "../ui/Picker.tsx"
import { EVERY } from "../ui/refresh.ts"
import { Banner, Empty, ErrorState, errorReason, Loading } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { ActorTag, Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { actionText, changesOf, itemActivity } from "./audit.ts"
import { afterOwnChange, draftBase, saveVersion } from "./draft.ts"

const TITLE_MAX = LIMITS.title
const BODY_MAX = LIMITS.body
const COMMENT_MAX = LIMITS.comment

export function ItemDialog({ itemId }: { itemId: string }) {
  const { t } = useI18n()
  const closeItem = useCloseItem()
  const query = useQuery({
    queryKey: qk.item(itemId),
    queryFn: () => api.item(itemId),
    refetchInterval: EVERY.live,
    refetchIntervalInBackground: false,
  })
  const detail = query.data
  const item = detail?.item
  const [title, setTitle] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [comment, setComment] = useState("")
  const [baseVersion, setBaseVersion] = useState<number | null>(null)
  const [conflict, setConflict] = useState(false)
  const leaving = useRef(false)
  const startDraft = () => {
    if (item) setBaseVersion((base) => draftBase(base, item.version))
  }
  const dropDraft = () => {
    setTitle(null)
    setBody(null)
    setBaseVersion(null)
    setConflict(false)
  }

  const titleDirty = item && title !== null && title !== item.title
  const bodyDirty = item && body !== null && body !== (item.body ?? "")
  const count = (titleDirty ? 1 : 0) + (bodyDirty ? 1 : 0) + (comment.trim() ? 1 : 0)
  useUnsaved("item-dialog", {
    count,
    kind: "discard",
    keeps: (next) => leaving.current || new URLSearchParams(next.search).get(ITEM_PARAM) === itemId,
  })

  const close = async () => {
    if (count > 0) {
      const discard = await confirmDialog({
        title: t("unsaved.discardTitle"),
        message: t("unsaved.discardMessage"),
        confirmText: t("unsaved.discard"),
        cancelText: t("unsaved.keepEditing"),
        focusCancel: true,
      })
      if (!discard) return
    }
    leaving.current = true
    closeItem()
  }

  const heading = item ? `${detail?.project?.name ?? t("inbox")} · ${t(`itemType.${item.type}`)}` : t("item.title")
  return (
    <Dialog
      size="md"
      title={<bdi dir="auto">{heading}</bdi>}
      onClose={() => void close()}
      noHistory
      initialFocus={() => document.querySelector<HTMLElement>("[data-item-status]")}
      foot={
        item ? (
          <ItemFoot
            item={item}
            dirty={!!(titleDirty || bodyDirty)}
            title={title}
            body={body}
            baseVersion={baseVersion}
            onSaved={dropDraft}
            onConflict={(currentVersion) => {
              // The owner is told; saving again replaces the change with the draft knowingly.
              setConflict(true)
              setBaseVersion(currentVersion)
            }}
            onDeleted={() => {
              leaving.current = true
              closeItem()
            }}
          />
        ) : null
      }
    >
      {query.isPending ? <Loading label={t("item.loading")} /> : null}
      {!item && query.isError ? (
        query.error instanceof ApiError && query.error.code === "not_found" ? (
          <Empty title={t("item.notFound")} hint={t("item.notFoundHint")} />
        ) : (
          <ErrorState title={t("item.failed")} error={query.error} onRetry={() => void query.refetch()} />
        )
      ) : null}
      {conflict && item && (titleDirty || bodyDirty) ? (
        <Banner
          tone="warn"
          title={t("item.conflictTitle")}
          action={
            <button type="button" className="ui-btn" onClick={dropDraft}>
              {t("item.conflictReload")}
            </button>
          }
        >
          {t("item.conflictBody")}
        </Banner>
      ) : null}
      {detail && item ? (
        <ItemBody
          detail={detail}
          item={item}
          title={title ?? item.title}
          body={body ?? item.body ?? ""}
          comment={comment}
          onTitle={(value) => {
            startDraft()
            setTitle(value)
          }}
          onBody={(value) => {
            startDraft()
            setBody(value)
          }}
          onComment={setComment}
          onOwnChange={(before, next) => setBaseVersion((base) => afterOwnChange(base, before, next))}
        />
      ) : null}
    </Dialog>
  )
}

function ItemFoot({
  item,
  dirty,
  title,
  body,
  baseVersion,
  onSaved,
  onConflict,
  onDeleted,
}: {
  item: Item
  dirty: boolean
  title: string | null
  body: string | null
  baseVersion: number | null
  onSaved: () => void
  onConflict: (currentVersion: number | null) => void
  onDeleted: () => void
}) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const refresh = useRefreshItems()
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const patch: { title?: string; body?: string } = {}
    if (title !== null && title !== item.title) {
      if (!title.trim()) {
        showToast(t("item.titleRequired"), "error")
        document.getElementById("item-title")?.focus()
        return
      }
      patch.title = title.trim()
    }
    if (body !== null && body !== (item.body ?? "")) patch.body = body.trim()
    setBusy(true)
    try {
      const next = await api.updateItem(item.id, saveVersion(baseVersion, item.version), patch)
      queryClient.setQueryData<ItemDetail>(qk.item(item.id), (old) => (old ? { ...old, item: next } : old))
      onSaved()
      await refresh()
      showToast(t("item.saved", { title: next.title }), "success")
    } catch (error) {
      if (error instanceof ApiError && error.code === "version_conflict") {
        // The draft stays; the item underneath is read again and the dialog says so (with Reload).
        await queryClient.invalidateQueries({ queryKey: qk.item(item.id) })
        onConflict(queryClient.getQueryData<ItemDetail>(qk.item(item.id))?.item.version ?? null)
      } else if (error instanceof ApiError && error.code === "secret_suspected") {
        showToast(t("errors.secretSuspected"), "error")
      } else {
        showToast(t("item.saveFailed", { reason: errorReason(language, error) }), "error")
      }
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: t("item.deleteTitle", { title: item.title }),
      message: t("item.deleteMessage"),
      confirmText: t("item.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteItem(item.id, item.version)
      showToast(t("item.deleted", { title: item.title }), "success")
      onDeleted()
      queryClient.removeQueries({ queryKey: qk.item(item.id) })
      await refresh()
    } catch (error) {
      showToast(t("item.deleteFailed", { reason: errorReason(language, error) }), "error")
    }
  }
  return (
    <>
      <button type="button" className="ui-btn ui-btn-danger ui-foot-gap" onClick={() => void remove()}>
        {t("item.delete")}
      </button>
      <button type="button" className="ui-btn ui-btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
        {busy ? t("common.saving") : t("item.saveChanges")}
      </button>
    </>
  )
}

function ItemBody({
  detail,
  item,
  title,
  body,
  comment,
  onTitle,
  onBody,
  onComment,
  onOwnChange,
}: {
  detail: ItemDetail
  item: Item
  title: string
  body: string
  comment: string
  onTitle: (value: string) => void
  onBody: (value: string) => void
  onComment: (value: string) => void
  onOwnChange: (before: number, next: number) => void
}) {
  const { t, language } = useI18n()
  const ids = { status: useId(), type: useId(), severity: useId(), project: useId(), body: useId(), comment: useId() }
  const itemActions = useItemActions()
  // The owner's own one-click changes move an unsaved draft's base with them (draft.ts).
  const own = async (change: Promise<Item | null>) => {
    const before = item.version
    const next = await change
    if (next) onOwnChange(before, next.version)
    return next
  }
  const actions = {
    setStatus: (...args: Parameters<typeof itemActions.setStatus>) => own(itemActions.setStatus(...args)),
    setType: (...args: Parameters<typeof itemActions.setType>) => own(itemActions.setType(...args)),
    moveTo: (...args: Parameters<typeof itemActions.moveTo>) => own(itemActions.moveTo(...args)),
    update: (...args: Parameters<typeof itemActions.update>) => own(itemActions.update(...args)),
  }
  const queryClient = useQueryClient()
  const refresh = useRefreshItems()
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects, staleTime: 60_000 })
  const project = projects.data?.find((entry) => entry.id === item.projectId)
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)

  const setSeverity = async (severity: Severity) => {
    await actions.update(
      item,
      { severity },
      t("item.severitySet", { title: item.title, severity: t(`severity.${severity}`) }),
    )
  }
  const toggleGoal = async () => {
    if (!project?.goal) return
    const linked = item.goalId === project.goal.id
    await actions.update(
      item,
      { goalId: linked ? null : project.goal.id },
      linked ? t("item.goalUnlinked", { title: item.title }) : t("item.goalLinked", { title: item.title }),
    )
  }
  const addComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!comment.trim()) {
      setCommentError(t("item.commentEmpty"))
      return
    }
    setPosting(true)
    setCommentError(null)
    try {
      await api.addComment(item.id, comment.trim())
      onComment("")
      await Promise.all([queryClient.invalidateQueries({ queryKey: qk.item(item.id) }), refresh()])
      showToast(t("item.commentAdded"), "success")
    } catch (error) {
      setCommentError(
        error instanceof ApiError && error.code === "secret_suspected"
          ? t("errors.secretSuspected")
          : t("item.commentFailed", { reason: errorReason(language, error) }),
      )
    } finally {
      setPosting(false)
    }
  }

  return (
    <div>
      <section className="ui-section">
        <label className="ui-label" htmlFor="item-title">
          {t("item.titleLabel")}
        </label>
        <TitleField value={title} onChange={onTitle} />
        <p className="ui-hint">
          {t("item.createdBy", { actor: t(`actor.${item.createdBy}`) })} <Time value={item.createdAt} mode="full" />
          {item.statusSetBy ? (
            <>
              {" "}
              · {t("item.statusBy", { actor: t(`actor.${item.statusSetBy}`) })} <Time value={item.statusSetAt} />
            </>
          ) : null}
        </p>
      </section>

      <section className="ui-section ui-facts">
        <div className="ui-field">
          <label className="ui-label" htmlFor={ids.status}>
            {t("item.status")}
          </label>
          <select
            id={ids.status}
            data-item-status=""
            className="ui-select"
            value={item.status}
            onChange={(event) => void actions.setStatus(item, event.target.value as Item["status"])}
          >
            {ITEM_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`itemStatus.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={ids.type}>
            {t("item.type")}
          </label>
          <select
            id={ids.type}
            className="ui-select"
            value={item.type}
            onChange={(event) => void actions.setType(item, event.target.value as Item["type"])}
          >
            {ITEM_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`itemType.${type}`)}
              </option>
            ))}
          </select>
        </div>
        {item.type === "security" ? (
          <div className="ui-field">
            <label className="ui-label" htmlFor={ids.severity}>
              {t("item.severity")}
            </label>
            <select
              id={ids.severity}
              className="ui-select"
              value={item.severity ?? ""}
              onChange={(event) => void setSeverity(event.target.value as Severity)}
            >
              {item.severity ? null : <option value="">{t("item.severityUnset")}</option>}
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(`severity.${severity}`)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="ui-field">
          <span className="ui-label" id={ids.project}>
            {t("item.project")}
          </span>
          <Picker
            variant="field"
            labelledBy={ids.project}
            label={t("item.project")}
            searchLabel={t("picker.searchProjects")}
            value={item.projectId ?? ""}
            options={[
              { value: "", label: t("inbox") },
              ...(projects.data ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={(value) => {
              const next = value || null
              if (next === item.projectId) return
              const name = projects.data?.find((entry) => entry.id === next)?.name ?? null
              void actions.moveTo(item, next, name)
            }}
          />
        </div>
      </section>

      {project?.goal ? (
        <section className="ui-section">
          <label className="ui-check-label">
            <input
              type="checkbox"
              className="ui-check"
              checked={item.goalId === project.goal.id}
              onChange={() => void toggleGoal()}
            />
            <span>
              {t("item.countsToward")} <bdi dir="auto">{project.goal.text}</bdi>
            </span>
          </label>
        </section>
      ) : null}

      <section className="ui-section">
        <label className="ui-label" htmlFor={ids.body}>
          {t("item.body")}
        </label>
        <textarea
          id={ids.body}
          className="ui-textarea"
          dir="auto"
          rows={5}
          maxLength={BODY_MAX}
          value={body}
          placeholder={t("item.bodyPlaceholder")}
          onChange={(event) => onBody(event.target.value)}
        />
      </section>

      <section className="ui-section">
        <h4 className="ui-section-title">{t("item.threads")}</h4>
        {detail.threads.length === 0 ? (
          <p className="ui-hint">{t("item.noThreads")}</p>
        ) : (
          <ul className="ui-threads">
            {detail.threads.map((thread) => (
              <li key={thread.id}>
                <bdi dir="auto">{thread.title ?? t("thread.untitled")}</bdi>
                <Tag
                  tone={
                    thread.settled
                      ? "ok"
                      : thread.lastStatus === "waiting"
                        ? "warn"
                        : thread.lastStatus === "running"
                          ? "info"
                          : "neutral"
                  }
                >
                  {thread.settled
                    ? t("thread.settled")
                    : thread.lastStatus
                      ? t("thread.status", { status: thread.lastStatus })
                      : t("thread.unknown")}
                </Tag>
                <Copyable value={thread.threadId} />
                {thread.lastActivityAt ? (
                  <span className="ui-muted">
                    {t("thread.lastActivity")} <Time value={thread.lastActivityAt} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ui-section">
        <h4 className="ui-section-title">{t("item.comments")}</h4>
        {detail.comments.length === 0 ? <p className="ui-hint">{t("item.noComments")}</p> : null}
        {detail.comments.map((entry) => (
          <article key={entry.id} className="ui-comment">
            <span className="ui-comment-head">
              <ActorTag kind={entry.authorKind} label={entry.authorLabel} />
              <Time value={entry.createdAt} mode="full" />
            </span>
            <p className="ui-text-block" dir="auto">
              {entry.text}
            </p>
            {entry.noteId ? (
              <Link className="ui-link" to={`/notes/${entry.noteId}`}>
                {t("item.openNote")}
              </Link>
            ) : null}
          </article>
        ))}
        <form className="ui-form-stack" onSubmit={addComment} noValidate>
          <div className="ui-field">
            <label className="ui-label" htmlFor={ids.comment}>
              {t("item.newComment")}
            </label>
            <textarea
              id={ids.comment}
              className="ui-textarea"
              dir="auto"
              rows={3}
              maxLength={COMMENT_MAX}
              value={comment}
              aria-invalid={commentError ? true : undefined}
              onChange={(event) => onComment(event.target.value)}
            />
            {commentError ? (
              <p className="ui-field-error" role="alert">
                {commentError}
              </p>
            ) : null}
          </div>
          <div>
            <button type="submit" className="ui-btn" disabled={posting}>
              {posting ? t("item.commentPosting") : t("item.addComment")}
            </button>
          </div>
        </form>
      </section>

      <section className="ui-section">
        <h4 className="ui-section-title">{t("item.history")}</h4>
        {detail.audit.length === 0 ? (
          <p className="ui-hint">{t("item.noHistory")}</p>
        ) : (
          <ul className="ui-history">
            {detail.audit.map((entry) => {
              const changes = changesOf(language, entry)
              return (
                <li key={entry.id}>
                  <Time value={entry.at} />
                  <span>
                    <ActorTag kind={entry.actorKind} label={entry.actorLabel} /> {actionText(language, entry)}
                    {changes.map((change) => (
                      <span key={change.field} className="ui-change">
                        {" "}
                        · {change.field}: <bdi dir="auto">{change.before}</bdi> {t("common.arrow")}{" "}
                        <bdi dir="auto">{change.after}</bdi>
                      </span>
                    ))}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="ui-hint ui-history-links">
          {/* A move to another page: the dialog closes with it, and an unsaved draft asks first (unsaved.tsx). */}
          <Link to={itemActivity(item.id)} className="ui-link">
            {t("item.allActivity")}
          </Link>
          {item.projectId ? (
            <Link to={`/projects/${item.projectId}`} className="ui-link">
              {t("item.openProject", { project: detail.project?.name ?? "" })}
            </Link>
          ) : null}
        </p>
      </section>
    </div>
  )
}

/**
 * A text's direction by its first letter, as dir="auto" decides it on an input. Chromium does not follow a
 * textarea's current value for dir="auto", so an English title in the Hebrew UI would stand on the right.
 */
export function textDirection(text: string): "rtl" | "ltr" | "auto" {
  const first = /\p{L}/u.exec(text)?.[0]
  if (!first) return "auto"
  return /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u.test(first) ? "rtl" : "ltr"
}

/**
 * The title as a field that grows with it, so a long title shows whole on a phone (audit B-2). A title is one
 * line (the server folds every run of white space into one space): Enter adds no line break, and a pasted break
 * becomes a space.
 */
function TitleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = () => {
    const field = ref.current
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(fit, [value])
  useEffect(() => {
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  })
  return (
    <textarea
      ref={ref}
      id="item-title"
      className="ui-textarea ui-item-title-input"
      dir={textDirection(value)}
      rows={1}
      maxLength={TITLE_MAX}
      value={value}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault()
      }}
    />
  )
}

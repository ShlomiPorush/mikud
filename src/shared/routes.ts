// Paths of the web UI that other parts link to (Telegram messages). The UI must serve these paths.

export const UI_ROUTES = {
  home: "/",
  item: (id: string) => `/items/${encodeURIComponent(id)}`,
  note: (id: string) => `/notes/${encodeURIComponent(id)}`,
} as const

/** An absolute link under the public URL, keeping any path prefix it has. */
export function uiUrl(publicUrl: URL | string, path: string): string {
  const base = new URL(String(publicUrl))
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
  return new URL(path.replace(/^\/+/, ""), base).toString()
}

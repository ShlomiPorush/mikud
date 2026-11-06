// A note's body as Markdown (requirements section 10), through react-markdown with GitHub's extensions
// (remark-gfm). Raw HTML is never rendered: react-markdown leaves it as text. Every link and image address
// passes react-markdown's own defaultUrlTransform, which drops unsafe protocols such as javascript:; the
// components below only use the address it hands them. An image is shown as a link to it: the
// Content-Security-Policy allows no outside images, and a note must not load anything by itself.
//
// Direction (v3 RT): each block, list and table takes the direction of its own text (dir="auto") and lines up
// with it, so a Hebrew paragraph and an English list in the same note each read right; code is always left to
// right. Headings move one level down
// (# becomes h2): the page keeps its one h1. Tables scroll inside their own frame.

import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react"
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"

/** An address that leaves Mikud opens in a new tab. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(`${location.origin}/`)
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children?: ReactNode }) {
  const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6"
  return <Tag dir="auto">{children}</Tag>
}

type Props<T extends ElementType> = ComponentPropsWithoutRef<T> & { node?: unknown }
const strip = <T extends { node?: unknown }>({ node: _node, ...rest }: T) => rest

const COMPONENTS: Components = {
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,
  p: (props: Props<"p">) => <p dir="auto" {...strip(props)} />,
  ul: (props: Props<"ul">) => <ul dir="auto" {...strip(props)} />,
  ol: (props: Props<"ol">) => <ol dir="auto" {...strip(props)} />,
  li: (props: Props<"li">) => <li dir="auto" {...strip(props)} />,
  blockquote: (props: Props<"blockquote">) => <blockquote dir="auto" {...strip(props)} />,
  td: (props: Props<"td">) => <td dir="auto" {...strip(props)} />,
  th: (props: Props<"th">) => <th dir="auto" {...strip(props)} />,
  table: (props: Props<"table">) => (
    <div className="ui-md-table" dir="auto">
      <table dir="auto" {...strip(props)} />
    </div>
  ),
  pre: (props: Props<"pre">) => <pre dir="ltr" {...strip(props)} />,
  code: (props: Props<"code">) => <code dir="ltr" {...strip(props)} />,
  a: ({ href, children }: Props<"a">) => {
    // href is what defaultUrlTransform kept: an unsafe address arrives empty and is text only.
    if (!href) return <span>{children}</span>
    return isExternal(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href}>{children}</a>
    )
  },
  img: ({ src, alt }: Props<"img">) => {
    const label = alt || (typeof src === "string" ? src : "")
    if (typeof src !== "string" || !src) return <span>{label}</span>
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="ui-md-image">
        {label}
      </a>
    )
  },
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="ui-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} urlTransform={defaultUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

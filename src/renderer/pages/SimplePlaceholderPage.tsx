export function SimplePlaceholderPage(props: { title: string; body: string }): JSX.Element {
  return (
    <div className="border border-industrial-border bg-industrial-panel p-4">
      <p className="text-sm font-medium text-industrial-text">{props.title}</p>
      <p className="mt-2 text-sm text-industrial-muted">{props.body}</p>
    </div>
  )
}

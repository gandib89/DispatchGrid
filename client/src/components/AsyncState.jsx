export function AsyncState({
  loading,
  error,
  onRetry,
  isEmpty = false,
  emptyMessage = 'Nothing to show yet.',
  children,
}) {
  if (loading) {
    return (
      <div
        role="status"
        className="flex items-center gap-gutter rounded-card border border-edge bg-surface/50 p-gutter text-sm text-muted"
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-primary"
        />
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert" className="rounded-card border border-danger/30 bg-danger/10 p-gutter text-sm">
        {error.code ? <p className="font-semibold text-danger">{error.code}</p> : null}
        <p className={error.code ? 'mt-1' : undefined}>{error.message}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-toast border border-edge px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/10"
          >
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="rounded-card border border-edge p-gutter text-sm text-muted">{emptyMessage}</div>
    )
  }

  return children ?? null
}

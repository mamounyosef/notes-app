import React from 'react'

/** Keeps one broken cell or panel from taking the whole window down. */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Notes caught an error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty-hint" style={{ padding: 16 }}>
          Something went wrong in {this.props.label || 'this part of the app'}. Your notes on disk are untouched.
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>{' '}
            <button className="btn" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

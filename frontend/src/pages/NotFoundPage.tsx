import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div>
      <h1 className="bh-h1">Page not found</h1>
      <p>
        <Link to="/shelf">← Back to the shelf</Link>
      </p>
    </div>
  )
}

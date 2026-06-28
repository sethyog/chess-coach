import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 60000,
  // Send the session cookie on every cross-origin request. Without this,
  // gated routes will 401 even when the user is logged in.
  withCredentials: true,
});

// Call POST /games/analyze-batch and stream SSE progress events to onEvent.
// Returns the final 'done' event (or a plain JSON body when total === 0).
//
// onEvent is called with:
//   { type: 'start',    total }
//   { type: 'progress', completed, total, gameId, status }
//   { type: 'done',     total, completed, failed }
export async function streamGameAnalysis(format, onEvent) {
  const base = import.meta.env.VITE_API_URL || '/api';
  const resp = await fetch(`${base}/games/analyze-batch`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ format }),
    credentials: 'include',
  });

  // When there are 0 unanalyzed games the server returns plain JSON.
  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    return resp.json();
  }

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop(); // keep trailing incomplete chunk
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        onEvent(event);
        if (event.type === 'done') doneEvent = event;
      } catch { /* ignore malformed lines */ }
    }
  }
  return doneEvent || { total: 0, completed: 0, failed: 0 };
}

// AuthContext registers a callback here on mount. Any 401 response (e.g. an
// expired session interrupting a normal data call) trips it; the callback
// clears local user state and RequireAuth swaps in the Login screen.
let onUnauthenticated = null;
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && onUnauthenticated) {
      onUnauthenticated();
    }
    return Promise.reject(error);
  }
);
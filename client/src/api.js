import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 60000,
  // Send the session cookie on every cross-origin request. Without this,
  // gated routes will 401 even when the user is logged in.
  withCredentials: true,
});

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
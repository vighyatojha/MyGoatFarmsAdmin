// Turns Firebase callable-function errors into messages an admin can act on.
// Firebase's own messages are terse ("internal", "NOT_FOUND"); when the server
// sent a real explanation (e.g. "Farm deletion failed at FARM_RECURSIVE_DELETE: …")
// we keep it, otherwise we map the error code to plain language.

const HINTS = {
  'functions/internal':
    'Delete service not responding. The deleteFarm Cloud Function is probably not deployed (or is crashing) — check Firebase Console → Functions → Logs.',
  'functions/not-found':
    'Delete service not found. Deploy the deleteFarm Cloud Function: firebase deploy --only functions',
  'functions/unauthenticated':
    'Your admin session has expired. Please sign in again.',
  'functions/permission-denied':
    'This account is not allowed to delete farms. Add its UID as a document in the "admins" collection.',
  'functions/deadline-exceeded':
    'Deletion is taking longer than expected. Refresh in a minute to see whether it finished.',
  'functions/unavailable':
    'Could not reach the server. Check your internet connection and try again.',
  'functions/resource-exhausted':
    'Too many requests right now. Please wait a moment and try again.',
};

export function explainCallableError(err, fallback = 'Something went wrong.') {
  const code = String(err?.code || '');
  const raw = String(err?.message || '').trim();
  const suffix = code.replace('functions/', '');
  const norm = (s) => s.toLowerCase().replace(/[-_\s]/g, '');
  const isGeneric = !raw || norm(raw) === norm(suffix);

  if (!isGeneric) return raw;                 // the server told us something specific
  return HINTS[code] || (raw ? raw : fallback);
}

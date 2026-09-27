import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

// If the auth SDK or the admins/{uid} lookup never comes back (dead network,
// a stalled connection, etc.) there was previously nothing to stop the page
// waiting on this promise forever — which is what produced the blank,
// permanently-stuck screen. This timeout guarantees the promise always
// settles one way or another.
const ADMIN_CHECK_TIMEOUT_MS = 12000;

/**
 * Resolves with the signed-in Firebase user once we've confirmed they're an
 * admin (an admins/{uid} document exists for them). Otherwise signs them out
 * and sends them back to the login page. Rejects (instead of hanging) if the
 * check doesn't complete within ADMIN_CHECK_TIMEOUT_MS.
 * Every admin-only page should await this before doing anything that needs
 * the signed-in user — but see initAdminShell(), which no longer waits on
 * this to paint the sidebar/topbar.
 */
export function requireAdmin() {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error('Still checking your sign-in — this is taking longer than usual. Check your connection and reload the page.'));
    }, ADMIN_CHECK_TIMEOUT_MS);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (settled) return;
      unsubscribe();
      if (!user) {
        settled = true;
        clearTimeout(timeoutId);
        location.href = '/admin/';
        return;
      }
      try {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        if (settled) return; // timed out while the admin-doc lookup was in flight
        settled = true;
        clearTimeout(timeoutId);
        if (!adminDoc.exists()) {
          await signOut(auth);
          location.href = '/admin/';
          return;
        }
        resolve(user);
      } catch {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        location.href = '/admin/';
      }
    });
  });
}

export async function logout() {
  await signOut(auth);
  location.href = '/admin/';
}

// Firebase setup for the admin panel. The project config lives in
// firebase-options.js; security comes from Firebase Auth + firestore.rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

import { firebaseConfig } from './firebase-options.js?v=20261007c';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// The admin panel is a single page, so live listeners survive navigation.
// persistentLocalCache still backs the cache with IndexedDB so a fresh visit
// paints from cache instantly while Firestore syncs in the background;
// persistentMultipleTabManager keeps it correct with several tabs open.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

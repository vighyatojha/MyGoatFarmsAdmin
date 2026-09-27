import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

// Already signed in as a confirmed admin? Skip the login form.
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const adminDoc = await getDoc(doc(db, 'admins', user.uid));
    if (adminDoc.exists()) location.href = 'dashboard.html';
  } catch { /* stay on the login page */ }
});

$('togglePassword').addEventListener('click', () => {
  const input = $('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('togglePassword').setAttribute('aria-pressed', String(show));
});

function friendlyError(code) {
  switch (code) {
    case 'auth/invalid-email': return 'Please enter a valid email address.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Incorrect email or password.';
    case 'auth/too-many-requests': return 'Too many attempts. Please wait a moment and try again.';
    default: return 'Sign-in failed. Please try again.';
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = $('loginError');
  const btn = $('loginBtn');
  errorBox.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);

    const adminDoc = await getDoc(doc(db, 'admins', cred.user.uid));
    if (!adminDoc.exists()) {
      await signOut(auth);
      throw { code: 'not-admin' };
    }
    location.href = 'dashboard.html';
  } catch (err) {
    errorBox.textContent = err.code === 'not-admin' ? 'This account is not authorized as an admin.' : friendlyError(err.code);
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

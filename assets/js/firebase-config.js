// TODO(DEVELOPER): replace with YOUR Firebase project's web config.
// Firebase Console → ⚙ Project settings → General → Your apps → Web app → SDK setup and configuration.
// These values identify your project — they are NOT secret and are safe to ship in a static site.
// Actual security comes from Firebase Authentication + the rules in firestore.rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyDZdySTm9seobFg51AXNvDOSi4pF4ZMYq4",
  authDomain: "mygoatfarms-5813a.firebaseapp.com",
  projectId: "mygoatfarms-5813a",
  storageBucket: "mygoatfarms-5813a.firebasestorage.app",
  messagingSenderId: "694889896033",
  appId: "1:694889896033:web:c671cecad3297a919df220",
  measurementId: "G-EDW8GTC4EG"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

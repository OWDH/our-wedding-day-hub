// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  initializeFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  increment,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  deleteDoc,
  serverTimestamp,
  limit
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js";
const firebaseConfig = {
  apiKey: "AIzaSyDQ2gwuJoe2si8xYfhB6n9mESfSon4zRq8",
  authDomain: "ourweddingdayhub.firebaseapp.com",
  projectId: "ourweddingdayhub",
  storageBucket: "ourweddingdayhub.firebasestorage.app",
  messagingSenderId: "221957124766",
  appId: "1:221957124766:web:83b7ba2351c1ad656e018f"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
});
const storage = getStorage(app);
export {
  app,
  auth,
  db,
  storage,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  increment,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  deleteDoc,
  serverTimestamp,
  limit,
  ref,
  uploadBytes,
  getDownloadURL
};
export const FUNCTIONS_API_BASE = "https://us-central1-ourweddingdayhub.cloudfunctions.net/api";

export function isMissingFunctionsRoute(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const message = String(err.message || "");
  return /Cannot POST/i.test(message) || /Endpoint not found/i.test(message);
}

export async function callFunctionsApi(path, { method = "POST", body, user } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) {
    const token = await user.getIdToken();
    headers.Authorization = "Bearer " + token;
  }
  const res = await fetch(FUNCTIONS_API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.alreadyPaid) return data;
  if (!res.ok) {
    const err = new Error(data.error || (res.status === 404 ? "Endpoint not found" : "Request failed"));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

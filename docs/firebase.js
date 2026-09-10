// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword as firebaseCreateUserWithEmailAndPassword,
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

// Vendor signup can be left in a half-created state if Firebase Authentication
// succeeds but the profile/payment step fails afterwards. On the signup page,
// resume the same-role account when the vendor retries with the same password
// instead of trapping them behind auth/email-already-in-use.
async function createUserWithEmailAndPassword(authInstance, email, password) {
  try {
    if (typeof window !== "undefined") window.__owdhResumedSignup = false;
    return await firebaseCreateUserWithEmailAndPassword(authInstance, email, password);
  } catch (error) {
    const onSignupPage = typeof document !== "undefined" && Boolean(document.getElementById("signupForm"));
    if (!onSignupPage || !error || error.code !== "auth/email-already-in-use") throw error;

    const credential = await signInWithEmailAndPassword(authInstance, email, password);
    const vendorTab = document.getElementById("tabVendor");
    const coupleTab = document.getElementById("tabCouple");
    const requestedRole = vendorTab && vendorTab.classList.contains("active")
      ? "vendor"
      : (coupleTab && coupleTab.classList.contains("active") ? "couple" : "");

    try {
      const existingUserSnap = await getDoc(doc(db, "users", credential.user.uid));
      const existingRole = existingUserSnap.exists() ? String(existingUserSnap.data().role || "") : "";
      if (existingRole && requestedRole && existingRole !== requestedRole) {
        await signOut(authInstance);
        throw error;
      }
    } catch (lookupError) {
      // A missing/blocked profile lookup is consistent with the partial-signup
      // state we are recovering from. Only propagate the original auth error
      // when we deliberately detected a role mismatch above.
      if (lookupError === error) throw lookupError;
      console.warn("Could not verify existing signup profile; resuming account:", lookupError);
    }

    if (typeof window !== "undefined") window.__owdhResumedSignup = true;
    return credential;
  }
}

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

const VENDOR_PAYMENT_LINKS = {
  edit: "https://buy.stripe.com/28E8wPfWk5tt1uV49AdnW08",
  spotlight: "https://buy.stripe.com/14A7sL6lKg872yZaxYdnW09",
  feature: "https://buy.stripe.com/7sYeVddOcaNN0qR7lMdnW0a",
  icon: "https://buy.stripe.com/eVqcN56lK9JJb5vaxYdnW0b"
};
const VENDOR_PLAN_ALIASES = {
  classic: "edit",
  signature: "spotlight",
  elite: "feature",
  platinum: "icon",
  edit: "edit",
  spotlight: "spotlight",
  feature: "feature",
  icon: "icon"
};

function directVendorPaymentLink(plan, user) {
  const tier = VENDOR_PLAN_ALIASES[String(plan || "").trim().toLowerCase()] || "";
  const base = VENDOR_PAYMENT_LINKS[tier];
  if (!base) return "";
  const url = new URL(base);
  if (user && user.uid) url.searchParams.set("client_reference_id", user.uid);
  if (user && user.email) url.searchParams.set("prefilled_email", user.email);
  return url.toString();
}

export async function callFunctionsApi(path, { method = "POST", body, user } = {}) {
  // Use the four approved Stripe Payment Links for new vendor checkout. This
  // avoids reusing a stale open Checkout Session from a different tier, which
  // was causing every package choice to reopen the original/lowest package.
  if (path === "/create-checkout-session" && method === "POST" && body && body.plan) {
    const paymentUrl = directVendorPaymentLink(body.plan, user);
    if (paymentUrl) return { url: paymentUrl, paymentLink: true };
  }

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

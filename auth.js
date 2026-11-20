// Shared Firebase setup for login.html and index.html
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp, query, orderBy }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const configured = !!firebaseConfig.apiKey && !/^PASTE/.test(firebaseConfig.apiKey);

let auth = null, db = null;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

// Resolves once Firebase knows whether someone is signed in (null if not)
export function whenUser() {
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, user => { stop(); resolve(user); });
  });
}

export async function googleSignIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    return (await signInWithPopup(auth, provider)).user;
  } catch (e) {
    // Some mobile browsers and in-app browsers block popups: fall back to a full-page redirect
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw e;
  }
}
export async function redirectResult() {
  try { const r = await getRedirectResult(auth); return r ? r.user : null; } catch (e) { throw e; }
}
export const logout = () => signOut(auth);

// Each user's wallets live at users/{uid}/wallets/{walletId}
export function walletStore(uid) {
  const col = collection(db, "users", uid, "wallets");
  return {
    async list() {
      const snap = await getDocs(query(col, orderBy("createdAt")));
      return snap.docs.map(d => ({ id: d.id, chain: d.get("chain"), addr: d.get("addr"), label: d.get("label") || "" }));
    },
    add: w => setDoc(doc(col, w.id), { chain: w.chain, addr: w.addr, label: w.label || "", createdAt: serverTimestamp() }),
    remove: id => deleteDoc(doc(col, id)),
  };
}

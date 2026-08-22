/* ---------------- PER-CLINIC FIREBASE CONFIGURATION ----------------
   This is the ONLY file that differs between clinic deployments.

   It exists so index.html can be byte-identical on every clinic's site.
   These values used to live inside index.html's inline <script type="module">,
   which is the block stamp_csp_hash.py takes the SHA-256 of — so editing them
   per clinic changed the hash, and a copy deployed without re-stamping showed
   a blank page and "Refused to execute inline script". Out here, the hash
   never moves and deploying an update is a straight file copy.

   These are not secrets. The Firebase web API key is public by design — it
   identifies the project, it does not authorise anything. Firestore Security
   Rules are the actual access boundary. Restrict the key by HTTP referrer in
   the Google Cloud console anyway (see SEC-06 in the tech lead review).

   To provision a new clinic: create its Firebase project (see
   Firebase_New_Project_Setup_Guide), then replace the six values below with
   that project's own. Change nothing else. */
window.__CLINIC_CONFIG = {

  // Which clinic inside this project the public booking page books into.
  // The staff app gets this from the signed-in user's profile; book.html has
  // no user, so it has to be told. Firebase Console > Firestore > clinics >
  // the document ID. Leave "" to switch public booking off entirely.
  clinicId: "",

  apiKey: "AIzaSyBPPuX3w5G_Rey-4r4g4o637nq781N_Zhw",
  authDomain: "saifee-homeopathic.firebaseapp.com",
  projectId: "saifee-homeopathic",
  storageBucket: "saifee-homeopathic.firebasestorage.app",
  messagingSenderId: "241727266755",
  appId: "1:241727266755:web:1af9923f790cb4cc04a776"
};

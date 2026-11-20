# Ledgerwatch — Firebase setup (about 10 minutes)

Ledgerwatch uses Firebase for Google sign-in and to save each user's wallet addresses in Firestore. The free Spark plan is enough.

## 1. Create the project
1. Go to https://console.firebase.google.com and click **Add project** (Google Analytics is optional).
2. In the project, click the **Web** icon (`</>`) to register a web app. Any nickname works; skip Firebase Hosting.
3. Copy the `firebaseConfig` values it shows into `firebase-config.js` in this repo.

## 2. Turn on Google sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**, pick a support email, **Save**.
3. **Settings → Authorized domains → Add domain** and add `rakeshsoorie4.github.io`.
   (`localhost` is already there for local testing.)

## 3. Create the database
1. **Build → Firestore Database → Create database**.
2. Pick a location close to your users (for India, `asia-south1` Mumbai), and start in **production mode**.
3. Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.

## 4. Publish
Commit `index.html`, `login.html`, `auth.js`, `firebase-config.js` and `firestore.rules` to the repo. GitHub Pages updates in a minute or two.
Open the site: signed-out visitors go to `login.html`; after signing in, wallets are saved under
`users/{your uid}/wallets` and you can see them in the Firestore console.

## Notes
- The values in `firebase-config.js` are meant to be public. The Firestore rules are what stop one user from reading another's wallets.
- Wallets added in a browser before login existed are imported into the account automatically on first sign-in.
- To test locally, serve the folder over http (for example `python3 -m http.server`) rather than opening the file directly, because the page uses JavaScript modules.

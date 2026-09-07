'use strict';
// CLOUD SAVES.
//
// The INTERFACE is copied from cifi-tools deliberately -- same state fields, same localStorage
// keys, same manual-sync semantics -- because users move between the two tools and a backup that
// behaves differently in each is worse than no backup. The BACKEND is ours (Appwrite), because we
// obviously cannot write to theirs.
//
// WHAT THE ORIGINAL DOES, read out of its bundle rather than guessed:
//   - one record per user: `userBackups/{uid}` holding `{ backupCode, appVersion, updatedAt }`
//   - client state: isSyncing / lastUploadTime / lastDownloadTime / lastCloudSaveTime /
//     hasNewerCloudBackup / syncStatus / lastSyncError
//   - four localStorage keys: sync_last_sync_time, sync_last_upload_time,
//     sync_last_download_time, sync_last_cloud_save_time
//   - a realtime subscription on the record's metadata that flips "New Backup Available"
//   - syncToServer  = createLocalBackup -> save -> stamp all four timestamps
//     syncFromServer = fetch -> restoreLocalBackup -> stamp the download time
//
// NOTHING IS AUTOMATIC. Upload and download are both explicit user actions, exactly as in the
// original. There is no merge: a store is a single interdependent document (builds reference
// hunter state, which references gem state), so field-level merging would produce combinations
// that neither device ever had. The user picks a direction and the other side is replaced.
//
// SIZE IS CHECKED, NOT ASSUMED. The `data` attribute holds 1,000,000 characters. A store that
// exceeds it must FAIL LOUDLY -- a truncated backup restores as corrupt JSON, which is the worst
// possible outcome for a feature whose whole job is not losing data.
(function (global) {
  const ENDPOINT = 'https://appwrite.athyen.pl/v1';
  const PROJECT = '6a9f0856001d7f2bd549';
  const DATABASE = 'cifi-cloud-saves';
  const COLLECTION = 'hunter_sim';

  // Bumped only when the payload SHAPE changes in a way an older client could misread. It is
  // stored beside the data so a mismatch is detectable instead of surfacing as a confusing
  // restore failure much later.
  const PAYLOAD_VERSION = 1;
  const MAX_DATA_CHARS = 1000000;

  const LS = {
    sync: 'sync_last_sync_time',
    upload: 'sync_last_upload_time',
    download: 'sync_last_download_time',
    cloudSave: 'sync_last_cloud_save_time',
  };

  const state = {
    ready: false,
    available: false,      // SDK present and client constructed
    isAuthenticated: false,
    user: null,
    isSyncing: false,
    syncStatus: 'idle',    // idle | syncing | success | error
    lastSyncError: null,
    lastSyncTime: null,
    lastUploadTime: null,
    lastDownloadTime: null,
    lastCloudSaveTime: null,
    hasNewerCloudBackup: false,
  };

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => { try { fn(snapshot()); } catch { /* a bad listener must not break sync */ } }); }
  function snapshot() { return { ...state, userDisplayName: displayName(), canSync: canSync() }; }
  function displayName() { return (state.user && (state.user.name || state.user.email)) || null; }
  function canSync() { return Boolean(state.available && state.isAuthenticated && !state.isSyncing); }

  let sdk = null;
  let client = null;
  let account = null;
  let databases = null;
  let unsubscribeRealtime = null;

  function readStamp(key) {
    let v = null;
    try { v = localStorage.getItem(key); } catch { return null; }
    if (!v) return null;
    // A timestamp in the FUTURE means a clock change (or a corrupted value) and would make every
    // cloud record look older than local forever, permanently hiding the "newer backup" badge.
    // The original clears it for exactly this reason; so do we.
    if (new Date(v).getTime() > Date.now()) {
      try { localStorage.removeItem(key); } catch { /* nothing else to do */ }
      return null;
    }
    return v;
  }

  function writeStamp(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: state still lives in memory */ }
  }

  /** The store, serialized exactly the way the Settings page's backup code does it. */
  function createLocalBackup() {
    if (typeof global.createStoreBackup !== 'function') {
      throw new Error('cloudSync: createStoreBackup() is not available -- app.js must load first');
    }
    return global.createStoreBackup();
  }

  function restoreLocalBackup(code) {
    if (typeof global.restoreStoreBackup !== 'function') {
      throw new Error('cloudSync: restoreStoreBackup() is not available -- app.js must load first');
    }
    return global.restoreStoreBackup(code);
  }

  function docIdFor(userId) {
    // One backup per user, addressed by the user's own id -- the same shape as the original's
    // `userBackups/{uid}`. It makes "get my backup" a direct read rather than a query, and makes
    // a second backup for the same user structurally impossible.
    return String(userId);
  }

  async function refreshAuth() {
    if (!account) return;
    try {
      state.user = await account.get();
      state.isAuthenticated = true;
    } catch {
      state.user = null;
      state.isAuthenticated = false;
    }
    emit();
  }

  async function loadMetadata() {
    if (!state.isAuthenticated || !databases) return null;
    try {
      const doc = await databases.getDocument(DATABASE, COLLECTION, docIdFor(state.user.$id));
      return { updatedAt: doc.updatedAt || doc.$updatedAt, appVersion: doc.appVersion || null };
    } catch {
      return null; // no backup yet is a normal state, not an error
    }
  }

  function markNewerIfAhead(cloudUpdatedAt) {
    if (!cloudUpdatedAt) { state.hasNewerCloudBackup = false; emit(); return; }
    state.lastCloudSaveTime = cloudUpdatedAt;
    writeStamp(LS.cloudSave, cloudUpdatedAt);
    // "Newer" is measured against what THIS browser last exchanged with the server, not against
    // the local edit time -- the question the badge answers is "is there something here I have
    // not pulled", which is exactly a comparison against the last upload/download.
    const seen = state.lastDownloadTime || state.lastUploadTime;
    state.hasNewerCloudBackup = !seen || new Date(cloudUpdatedAt).getTime() > new Date(seen).getTime();
    emit();
  }

  function startRealtime() {
    stopRealtime();
    if (!client || !state.isAuthenticated) return;
    const channel = `databases.${DATABASE}.collections.${COLLECTION}.documents.${docIdFor(state.user.$id)}`;
    try {
      unsubscribeRealtime = client.subscribe(channel, (msg) => {
        const doc = msg && msg.payload;
        if (doc) markNewerIfAhead(doc.updatedAt || doc.$updatedAt);
      });
    } catch {
      // Realtime is a convenience: without it the badge simply updates on the next poll or
      // sign-in. It must never take the rest of sync down with it.
      unsubscribeRealtime = null;
    }
  }

  function stopRealtime() {
    if (unsubscribeRealtime) { try { unsubscribeRealtime(); } catch { /* already gone */ } }
    unsubscribeRealtime = null;
  }

  const api = {
    get state() { return snapshot(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * Wire up the SDK. Safe to call when the SDK failed to load: everything then reports
     * `available: false` and the UI can say so, rather than throwing on first use.
     */
    async init() {
      if (state.ready) return snapshot();
      state.ready = true;
      state.lastSyncTime = readStamp(LS.sync);
      state.lastUploadTime = readStamp(LS.upload);
      state.lastDownloadTime = readStamp(LS.download);
      state.lastCloudSaveTime = readStamp(LS.cloudSave);

      sdk = global.Appwrite || null;
      if (!sdk || !sdk.Client) { state.available = false; emit(); return snapshot(); }
      client = new sdk.Client().setEndpoint(ENDPOINT).setProject(PROJECT);
      account = new sdk.Account(client);
      databases = new sdk.Databases(client);
      state.available = true;

      await refreshAuth();
      if (state.isAuthenticated) {
        markNewerIfAhead((await loadMetadata() || {}).updatedAt);
        startRealtime();
      }
      emit();
      return snapshot();
    },

    /**
     * Discord OAuth. This NAVIGATES THE PAGE AWAY -- it does not resolve, and anything queued
     * after it will not run. Appwrite sends the browser to Discord and Discord sends it back to
     * `success`, at which point the session cookie is already set and `init()` picks it up on the
     * next boot, so there is no callback to handle here.
     *
     * Both URLs are the page the user is on, so a deployment at any origin returns to itself
     * rather than to a hard-coded host.
     */
    signInWithDiscord() {
      if (!state.available) throw new Error('Cloud sync is unavailable (the Appwrite SDK did not load).');
      const here = global.location.href.split('#')[0];
      account.createOAuth2Session('discord', here, here);
    },

    async signUp(email, password, name) {
      if (!state.available) throw new Error('Cloud sync is unavailable (the Appwrite SDK did not load).');
      await account.create(sdk.ID.unique(), email, password, name || undefined);
      return api.signIn(email, password);
    },

    async signIn(email, password) {
      if (!state.available) throw new Error('Cloud sync is unavailable (the Appwrite SDK did not load).');
      await account.createEmailPasswordSession(email, password);
      await refreshAuth();
      if (state.isAuthenticated) {
        markNewerIfAhead((await loadMetadata() || {}).updatedAt);
        startRealtime();
      }
      return snapshot();
    },

    async signOut() {
      stopRealtime();
      try { if (account) await account.deleteSession('current'); } catch { /* already gone */ }
      state.user = null;
      state.isAuthenticated = false;
      state.hasNewerCloudBackup = false;
      // THE SYNC STAMPS DESCRIBE AN ACCOUNT, NOT A BROWSER, so they must not outlive the session.
      //
      // `hasNewerCloudBackup` is computed by comparing the cloud record's updatedAt against the
      // last upload/download THIS browser did. Leaving one account's stamps in place means the
      // next account is measured against a baseline that has nothing to do with it -- and the
      // failure is silent and in the dangerous direction: a stamp NEWER than the new account's
      // backup hides the "new backup available" notice, so the user never learns the cloud holds
      // something they have not pulled. Clearing on sign-out costs a first-run notice and removes
      // that whole class of wrong answer.
      for (const key of Object.values(LS)) {
        try { localStorage.removeItem(key); } catch { /* private mode: memory state is cleared below */ }
      }
      state.lastSyncTime = null;
      state.lastUploadTime = null;
      state.lastDownloadTime = null;
      state.lastCloudSaveTime = null;
      emit();
      return snapshot();
    },

    /** Local -> cloud. Replaces whatever is stored for this user. */
    async syncToServer() {
      if (!canSync()) throw new Error('Not signed in.');
      state.isSyncing = true; state.syncStatus = 'syncing'; state.lastSyncError = null; emit();
      try {
        const data = createLocalBackup();
        if (data.length > MAX_DATA_CHARS) {
          // Loud, with the numbers, because the alternative is a silently truncated backup that
          // only reveals itself as corrupt JSON when someone tries to restore it.
          throw new Error(`Backup is ${data.length.toLocaleString()} characters, over the `
            + `${MAX_DATA_CHARS.toLocaleString()} the cloud record holds. Nothing was uploaded.`);
        }
        const now = new Date().toISOString();
        const userId = state.user.$id;
        const id = docIdFor(userId);
        // Owner-only, written per document. The collection itself grants nothing but create, so a
        // document is unreadable by anyone else even if the collection is later opened up.
        const permissions = [
          sdk.Permission.read(sdk.Role.user(userId)),
          sdk.Permission.update(sdk.Role.user(userId)),
          sdk.Permission.delete(sdk.Role.user(userId)),
        ];
        const payload = { data, version: PAYLOAD_VERSION, updatedAt: now, userId, appVersion: appVersion() };
        try {
          await databases.updateDocument(DATABASE, COLLECTION, id, payload);
        } catch (e) {
          // First upload for this user: create carries createdAt, which update must not touch.
          await databases.createDocument(DATABASE, COLLECTION, id,
            { ...payload, createdAt: now }, permissions);
        }
        state.lastUploadTime = now;
        state.lastDownloadTime = now;
        state.lastSyncTime = now;
        state.lastCloudSaveTime = now;
        writeStamp(LS.upload, now); writeStamp(LS.download, now);
        writeStamp(LS.sync, now); writeStamp(LS.cloudSave, now);
        state.hasNewerCloudBackup = false;
        state.syncStatus = 'success';
        return snapshot();
      } catch (e) {
        state.syncStatus = 'error';
        state.lastSyncError = e.message;
        throw e;
      } finally {
        state.isSyncing = false; emit();
      }
    },

    /** Cloud -> local. Replaces the local store; the caller confirms first. */
    async syncFromServer() {
      if (!canSync()) throw new Error('Not signed in.');
      state.isSyncing = true; state.syncStatus = 'syncing'; state.lastSyncError = null; emit();
      try {
        let doc = null;
        try {
          doc = await databases.getDocument(DATABASE, COLLECTION, docIdFor(state.user.$id));
        } catch { doc = null; }
        if (!doc) {
          state.syncStatus = 'success';
          state.hasNewerCloudBackup = false;
          return { ...snapshot(), restored: false };
        }
        if (Number(doc.version) > PAYLOAD_VERSION) {
          throw new Error(`That backup was written by a newer version of this tool `
            + `(payload v${doc.version}, this build reads v${PAYLOAD_VERSION}). Update before restoring.`);
        }
        restoreLocalBackup(doc.data);
        const now = new Date().toISOString();
        const cloudAt = doc.updatedAt || doc.$updatedAt || now;
        state.lastDownloadTime = now;
        state.lastSyncTime = now;
        state.lastCloudSaveTime = cloudAt;
        writeStamp(LS.download, now); writeStamp(LS.sync, now); writeStamp(LS.cloudSave, cloudAt);
        state.hasNewerCloudBackup = false;
        state.syncStatus = 'success';
        return { ...snapshot(), restored: true };
      } catch (e) {
        state.syncStatus = 'error';
        state.lastSyncError = e.message;
        throw e;
      } finally {
        state.isSyncing = false; emit();
      }
    },

    /** Ask the server whether a newer backup exists, without downloading it. */
    async refreshCloudMetadata() {
      const meta = await loadMetadata();
      markNewerIfAhead(meta && meta.updatedAt);
      return meta;
    },

    // Exposed for the bench: the constants a test would otherwise duplicate.
    CONFIG: { ENDPOINT, PROJECT, DATABASE, COLLECTION, PAYLOAD_VERSION, MAX_DATA_CHARS, LS },
  };

  function appVersion() {
    return (global.APP_VERSION && String(global.APP_VERSION).slice(0, 32)) || 'huntersim';
  }

  global.CloudSync = api;
})(typeof window !== 'undefined' ? window : globalThis);

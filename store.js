const crypto = require("crypto");
const admin = require("firebase-admin");
const conversationId = (a, b) => crypto.createHash("sha256").update(JSON.stringify([a, b].sort())).digest("hex");
function createFirebaseStore() {
  if (!process.env.FIREBASE_CREDENTIALS) throw new Error("FIREBASE_CREDENTIALS is required.");
  const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS)) });
  const db = app.firestore();
  // Preserve the original 2024 data; the refresh uses an isolated namespace.
  const profiles = db.collection("talknest_v2_profiles");
  const chats = db.collection("talknest_v2_conversations");
  const store = {
    async profile(uid) { const d = await profiles.doc(uid).get(); return d.exists ? d.data() : null; },
    async saveProfile(uid, data) {
      await profiles.doc(uid).set({ ...data, uid }, { merge: true }); return this.profile(uid);
    },
    async search(q, uid) {
      const r = await profiles.orderBy("nameLower").startAt(q).endAt(q + "\uf8ff").limit(30).get();
      return r.docs.map(d => d.data()).filter(p => p.uid !== uid && p.discoverable).slice(0, 10);
    },
    async start(uid, other) {
      const id = conversationId(uid, other), ref = chats.doc(id);
      await db.runTransaction(async tx => {
        if (!(await tx.get(ref)).exists) tx.set(ref, { id, members: [uid, other], updatedAt: Date.now(), lastMessage: "" });
      });
      return { id, peer: await this.profile(other) };
    },
    async conversation(id) { const d = await chats.doc(id).get(); return d.exists ? d.data() : null; },
    async list(uid) {
      const r = await chats.where("members", "array-contains", uid).get();
      const values = await Promise.all(r.docs.map(async d => {
        const data = d.data();
        return { id: d.id, lastMessage: data.lastMessage, updatedAt: data.updatedAt,
          peer: await this.profile(data.members.find(member => member !== uid)) };
      }));
      return values.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async messages(id) {
      const r = await chats.doc(id).collection("messages").orderBy("createdAt", "desc").limit(100).get();
      return r.docs.map(d => d.data()).reverse();
    },
    async send(id, message) {
      const room = chats.doc(id), ref = room.collection("messages").doc(message.id);
      await db.runTransaction(async tx => {
        if ((await tx.get(ref)).exists) return; // Retry without duplicate delivery.
        tx.set(ref, message);
        tx.update(room, { updatedAt: message.createdAt, lastMessage: message.text });
      });
      return (await ref.get()).data();
    },
    async canCall(a, b) {
      const c = await this.conversation(conversationId(a, b));
      return Boolean(c && c.members.includes(a) && c.members.includes(b));
    },
  };
  return { store, verifyToken: token => app.auth().verifyIdToken(token, true) };
}
module.exports = { createFirebaseStore, conversationId };

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");
const uidValid = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const publicProfile = p => p && ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL || "" });

function createService({ store, verifyToken, origins = [], ringMs = 30000 }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); res.set("Cache-Control", "no-store"); next(); });
  const allowed = origin => !origin || origins.includes(origin);
  app.use(cors({ origin: (origin, done) => done(null, allowed(origin)) }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_, res) => res.json({ status: "ok", service: "talknest" }));
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 32768, cors: { origin: origins },
    allowRequest: (req, done) => done(null, allowed(req.headers.origin)) });
  const counts = new Map();
  function withinBudget(key, max = 90) {
    const now = Date.now();
    let item = counts.get(key);
    if (!item || item.until < now) item = { count: 0, until: now + 60000 };
    item.count++; counts.set(key, item); return item.count <= max;
  }
  const sweep = setInterval(() => { for (const [key, item] of counts) if (item.until < Date.now()) counts.delete(key); }, 60000);
  sweep.unref();
  app.use("/api", async (req, res, next) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
    if (!token) return res.status(401).json({ error: "Sign in to continue." });
    try { req.user = await verifyToken(token); if (!uidValid(req.user.uid)) throw new Error(); }
    catch { return res.status(401).json({ error: "Your session expired. Sign in again." }); }
    if (!withinBudget(req.user.uid)) return res.status(429).json({ error: "Please slow down and retry in a minute." });
    next();
  });
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  app.get("/api/me", route(async (req, res) => res.json(await store.profile(req.user.uid))));
  app.put("/api/me", route(async (req, res) => {
    const displayName = String(req.body.displayName || "").trim().slice(0, 70);
    if (!displayName) return res.status(400).json({ error: "A display name is required." });
    res.json(await store.saveProfile(req.user.uid, { displayName, nameLower: displayName.toLowerCase(),
      photoURL: /^https:\/\//.test(req.user.picture || "") ? req.user.picture : "",
      discoverable: req.body.discoverable === true }));
  }));
  app.get("/api/people", route(async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 70);
    res.json(q.length < 2 ? [] : (await store.search(q, req.user.uid)).map(publicProfile));
  }));
  app.get("/api/chats", route(async (req, res) => res.json((await store.list(req.user.uid)).map(c => ({ ...c, peer: publicProfile(c.peer) })))));
  app.post("/api/chats", route(async (req, res) => {
    const other = req.body.peerUid;
    if (!uidValid(other) || other === req.user.uid) return res.status(400).json({ error: "Choose another person." });
    if (!(await store.profile(other))?.discoverable) return res.status(404).json({ error: "This person is not available in the directory." });
    const c = await store.start(req.user.uid, other);
    res.json({ ...c, peer: publicProfile(c.peer) });
  }));
  async function member(req, res) {
    const c = /^[a-f0-9]{64}$/.test(req.params.id) ? await store.conversation(req.params.id) : null;
    if (!c || !c.members.includes(req.user.uid)) { res.status(404).json({ error: "Conversation not found." }); return null; }
    return c;
  }
  app.get("/api/chats/:id/messages", route(async (req, res) => {
    if (await member(req, res)) res.json(await store.messages(req.params.id));
  }));
  app.post("/api/chats/:id/messages", route(async (req, res) => {
    const c = await member(req, res); if (!c) return;
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 4000 || !/^[a-f0-9-]{36}$/.test(req.body.id || "")) return res.status(400).json({ error: "Enter a message of 1–4,000 characters." });
    const message = await store.send(c.id, { id: `${req.user.uid}_${req.body.id}`, senderId: req.user.uid, text, createdAt: Date.now() });
    c.members.forEach(uid => io.to(`user:${uid}`).emit("message", { chatId: c.id, message }));
    res.json(message);
  }));
  app.use((error, req, res, next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "Invalid request." });
    console.error("Request failed:", error.code || error.name);
    res.status(500).json({ error: "The service is unavailable. Please try again." });
  });
  const calls = new Map(), busy = new Map();
  function endCall(id, reason) {
    const c = calls.get(id); if (!c) return;
    clearTimeout(c.timer); calls.delete(id); busy.delete(c.from); busy.delete(c.to);
    [c.from, c.to].forEach(uid => io.to(`user:${uid}`).emit("call:ended", { id, reason }));
  }
  io.use(async (socket, next) => {
    try {
      const user = await verifyToken(socket.handshake.auth?.token);
      if (!uidValid(user.uid)) throw new Error();
      socket.data.uid = user.uid; socket.data.exp = user.exp; next();
    } catch { next(new Error("Authentication required")); }
  });
  io.on("connection", socket => {
    const uid = socket.data.uid; socket.join(`user:${uid}`);
    const expiry = socket.data.exp ? setTimeout(() => socket.disconnect(true), Math.max(1, socket.data.exp * 1000 - Date.now())) : null;
    const participant = id => {
      const c = calls.get(id);
      return c && (c.fromSocket === socket.id || c.toSocket === socket.id) ? c : null;
    };
    socket.on("call:start", async (p = {}, ack = () => {}) => {
      if (typeof ack !== "function") ack = () => {};
      try {
        if (!withinBudget(`call:${uid}`, 8)) return ack({ error: "Too many calls. Try again later." });
        if (!uidValid(p.to) || p.to === uid || !["audio", "video"].includes(p.mode)) return ack({ error: "Invalid call." });
        if (!await store.canCall(uid, p.to)) return ack({ error: "Start a conversation first." });
        if (!socket.connected) return;
        if (busy.has(uid) || busy.has(p.to)) return ack({ error: "One of you is already in a call." });
        if (!io.sockets.adapter.rooms.get(`user:${p.to}`)?.size) return ack({ error: "They are offline. Send a message instead." });
        const c = { id: randomUUID(), from: uid, to: p.to, fromSocket: socket.id, toSocket: null, mode: p.mode };
        c.timer = setTimeout(() => endCall(c.id, "No answer"), ringMs);
        calls.set(c.id, c); busy.set(uid, c.id); busy.set(p.to, c.id);
        io.to(`user:${p.to}`).emit("call:incoming", { id: c.id, from: publicProfile(await store.profile(uid)), mode: c.mode });
        ack({ id: c.id });
      } catch { ack({ error: "Could not start the call." }); }
    });
    socket.on("call:accept", payload => {
      const id = payload?.id;
      const c = calls.get(id); if (!c || c.to !== uid || c.toSocket) return;
      clearTimeout(c.timer); c.toSocket = socket.id;
      socket.to(`user:${uid}`).emit("call:handled", { id });
      io.to(c.fromSocket).emit("call:accepted", { id });
      c.timer = setTimeout(() => endCall(id, "Connection timed out"), 45000);
    });
    socket.on("call:connected", payload => { const c = participant(payload?.id); if (c) clearTimeout(c.timer); });
    socket.on("call:signal", payload => {
      const { id, signal } = payload || {};
      const c = participant(id);
      if (!c || !c.toSocket || !signal || JSON.stringify(signal).length > 24000 || !withinBudget(`signal:${socket.id}`, 300)) return;
      io.to(c.fromSocket === socket.id ? c.toSocket : c.fromSocket).emit("call:signal", { id, signal });
    });
    socket.on("call:end", payload => {
      const id = payload?.id;
      const c = calls.get(id);
      if (c && (participant(id) || (c.to === uid && !c.toSocket))) endCall(id, "Call ended");
    });
    socket.on("disconnect", () => {
      clearTimeout(expiry);
      for (const [id, c] of calls) if (c.fromSocket === socket.id || c.toSocket === socket.id) endCall(id, "Connection lost");
    });
  });
  server.on("close", () => { clearInterval(sweep); for (const c of calls.values()) clearTimeout(c.timer); });
  return { app, server, io };
}
module.exports = { createService };

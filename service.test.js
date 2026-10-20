const request = require("supertest");
const { io: client } = require("socket.io-client");
const { createService } = require("./service");
const { conversationId } = require("./store");
const id = conversationId("alice", "bob");
let service, sockets;
const people = {
  alice: { uid: "alice", displayName: "Alice", discoverable: true },
  bob: { uid: "bob", displayName: "Bob", discoverable: true },
  eve: { uid: "eve", displayName: "Eve", discoverable: true },
};
function makeStore() {
  const messages = new Map();
  return {
    profile: jest.fn(async uid => people[uid]),
    saveProfile: jest.fn(async (uid, value) => ({ ...value, uid })),
    search: jest.fn(async () => [people.bob]),
    list: jest.fn(async () => []),
    start: jest.fn(async () => ({ id, peer: people.bob })),
    conversation: jest.fn(async value => value === id ? { id, members: ["alice", "bob"] } : null),
    messages: jest.fn(async () => [...messages.values()]),
    send: jest.fn(async (_, message) => { if (!messages.has(message.id)) messages.set(message.id, message); return messages.get(message.id); }),
    canCall: jest.fn(async (a, b) => a !== "eve" && b !== "eve"),
  };
}
beforeEach(() => {
  sockets = [];
  service = createService({ store: makeStore(), origins: ["http://localhost:3000"],
    verifyToken: async token => { if (!people[token]) throw new Error(); return { uid: token }; },
    ringMs: 1500 });
});
afterEach(async () => {
  sockets.forEach(s => s.disconnect());
  await new Promise(resolve => service.io.close(resolve));
  if (service.server.listening) await new Promise(resolve => service.server.close(resolve));
});
const get = (path, token = "alice") => request(service.app).get(path).set("Authorization", "Bearer " + token);
test("health is public; private endpoints require authentication", async () => {
  expect((await request(service.app).get("/health")).status).toBe(200);
  expect((await request(service.app).get("/api/chats")).status).toBe(401);
  expect((await get("/api/chats", "invalid")).status).toBe(401);
});
test("missing search queries return empty lists without leaking directory", async () => {
  expect((await get("/api/people")).body).toEqual([]);
  expect((await get("/api/people?q=b")).body).toEqual([]);
});
test("chat membership is checked, not trusted from the client", async () => {
  expect((await get(`/api/chats/${id}/messages`, "eve")).status).toBe(404);
  expect((await get(`/api/chats/${id}/messages`, "bob")).status).toBe(200);
});
test("client cannot impersonate another message sender", async () => {
  const response = await request(service.app).post(`/api/chats/${id}/messages`)
    .set("Authorization", "Bearer alice").send({ id: "12345678-1234-1234-1234-123456789abc", text: "hello", senderId: "eve" });
  expect(response.status).toBe(200); expect(response.body.senderId).toBe("alice");
});
test("empty/oversized messages are rejected; retries preserve the message", async () => {
  const send = text => request(service.app).post(`/api/chats/${id}/messages`).set("Authorization", "Bearer alice")
    .send({ id: "12345678-1234-1234-1234-123456789abc", text });
  expect((await send(" ")).status).toBe(400);
  expect((await send("x".repeat(4001))).status).toBe(400);
  const first = await send("hello"), retry = await send("hello");
  expect(first.body).toEqual(retry.body);
  expect((await get(`/api/chats/${id}/messages`)).body).toHaveLength(1);
});
test("profile changes always apply to authenticated user and filter avatar URLs", async () => {
  const response = await request(service.app).put("/api/me").set("Authorization", "Bearer alice")
    .send({ uid: "eve", displayName: "New Name", photoURL: "https://untrusted.test/image.png", discoverable: false });
  expect(response.body.uid).toBe("alice"); expect(response.body.photoURL).toBe("");
});
test("foreign origins do not receive CORS permission", async () => {
  const response = await get("/api/me").set("Origin", "https://untrusted.test");
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
});
async function connect(token) {
  if (!service.server.listening) await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const socket = client(`http://127.0.0.1:${service.server.address().port}`, {
    auth: { token }, transports: ["websocket"], reconnection: false,
  });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}
const event = (socket, name) => new Promise(resolve => socket.once(name, resolve));
const start = (socket, to = "bob") => new Promise(resolve => socket.emit("call:start", { to, mode: "audio" }, resolve));
test("unauthenticated sockets are rejected", async () => { await expect(connect("invalid")).rejects.toThrow("Authentication required"); });
test("offline and unrelated recipients are rejected", async () => {
  const a = await connect("alice");
  expect((await start(a)).error).toContain("offline");
  expect((await start(a, "eve")).error).toContain("conversation");
});
test("call accept, signal, hang-up and busy state work across two clients", async () => {
  const a = await connect("alice"), b = await connect("bob"), e = await connect("eve");
  const incoming = event(b, "call:incoming"), result = await start(a);
  expect((await incoming).from.uid).toBe("alice");
  expect((await start(a)).error).toContain("already");
  const accepted = event(a, "call:accepted"); b.emit("call:accept", { id: result.id }); await accepted;
  const received = event(b, "call:signal");
  e.emit("call:signal", { id: result.id, signal: { description: "forged" } });
  a.emit("call:signal", { id: result.id, signal: { description: "real" } });
  expect((await received).signal.description).toBe("real");
  const ended = event(b, "call:ended"); a.emit("call:end", { id: result.id });
  expect((await ended).reason).toBe("Call ended");
  expect((await start(a)).id).toBeTruthy();
});
test("disconnect releases the call and notifies the other side", async () => {
  const a = await connect("alice"), b = await connect("bob");
  await start(a); const ended = event(b, "call:ended"); a.disconnect();
  expect((await ended).reason).toBe("Connection lost");
});

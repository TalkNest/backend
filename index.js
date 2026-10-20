require("dotenv").config();
const { createService } = require("./service");
const { createFirebaseStore } = require("./store");
const { store, verifyToken } = createFirebaseStore();
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
if (!origins.length) throw new Error("Set ALLOWED_ORIGINS to the frontend HTTPS origin.");
const { server, io } = createService({ store, verifyToken, origins });
server.listen(process.env.PORT || 4000, () => console.log("TalkNest API is listening"));
function shutdown() { io.close(); server.close(() => process.exit(0)); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

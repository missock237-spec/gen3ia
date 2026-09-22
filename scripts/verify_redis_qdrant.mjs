/**
 * Vérification live Redis (Upstash) + Qdrant avec les modules du projet.
 * Usage: UPSTASH_... QDRANT_... node scripts/verify_redis_qdrant.mjs
 */
import { Redis } from "@upstash/redis";
import { QdrantClient } from "@qdrant/js-client-rest";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_KEY = process.env.QDRANT_API_KEY;

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

// --- Redis ---
const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
check("redis.ping", (await redis.ping()) === "PONG");
await redis.set("g3:verify:t1", JSON.stringify({ a: 1, b: "deux" }), { ex: 60 });
const read = await redis.get("g3:verify:t1");
check("redis.set/get JSON", read && read.a === 1 && read.b === "deux", JSON.stringify(read));
const [c1] = await redis.pipeline().incr("g3:verify:counter").pexpire("g3:verify:counter", 60000).exec();
check("redis.pipeline incr/pexpire", Number(c1) >= 1, `count=${c1}`);
const pttl = await redis.pttl("g3:verify:counter");
check("redis.pttl > 0", typeof pttl === "number" && pttl > 0, `pttl=${pttl}`);
const del = await redis.del("g3:verify:t1");
check("redis.del", del >= 1);

// --- Qdrant ---
const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_KEY, checkCompatibility: false });
const cols = await qdrant.getCollections();
check("qdrant.getCollections", Array.isArray(cols.collections), `${cols.collections.length} collections`);

const TEST_COL = "gen3ia_verify_tmp";
const exRaw = await qdrant.collectionExists(TEST_COL);
const exists = typeof exRaw === "boolean" ? exRaw : Boolean(exRaw?.exists);
if (!exists) {
  await qdrant.createCollection(TEST_COL, { vectors: { size: 4, distance: "Cosine" } });
}
for (const field of ["userId", "projectId", "agentId", "documentId"]) {
  try {
    await qdrant.createPayloadIndex(TEST_COL, { field_name: field, field_schema: "keyword", wait: true });
  } catch {
    // déjà présent
  }
}
await qdrant.upsert(TEST_COL, {
  wait: true,
  points: [
    { id: 1, vector: [1, 0, 0, 0], payload: { userId: "u1", tag: "a" } },
    { id: 2, vector: [0, 1, 0, 0], payload: { userId: "u1", tag: "b" } },
    { id: 3, vector: [0.9, 0.1, 0, 0], payload: { userId: "u2", tag: "a" } },
  ],
});
const q = await qdrant.query(TEST_COL, {
  query: [1, 0, 0, 0],
  limit: 5,
  filter: { must: [{ key: "userId", match: { value: "u1" } }] },
  with_payload: true,
});
const top = q.points?.[0];
check("qdrant.query kNN + filtre userId", top && top.id === 1 && top.score > 0.99, `top=${JSON.stringify(top?.id)} score=${top?.score}`);
await qdrant.deleteCollection(TEST_COL);
check("qdrant.deleteCollection (nettoyage)", true);

console.log(failures === 0 ? "\nTOUT EST VERT" : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);

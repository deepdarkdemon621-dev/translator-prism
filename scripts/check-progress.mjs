import { config } from "dotenv";
import { createClient } from "@libsql/client";
config({ path: ".env.worker" });
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const res = await client.execute(
  "SELECT status, COUNT(*) c FROM translations GROUP BY status",
);
console.log("translations:", res.rows);
const err = await client.execute(
  "SELECT COALESCE(error_message,'(none)') e, COUNT(*) c FROM translations WHERE status='failed' GROUP BY error_message LIMIT 5",
);
console.log("failures:", err.rows);
client.close();

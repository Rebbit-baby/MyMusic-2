const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Env = {
  DB: D1Database; // 确保和 Cloudflare Pages D1 Binding 名一致
};

type JsonBody = {
  data?: Record<string, unknown>;
  keys?: string[];
};

const TABLES = {
  playback: "playback_store",
  favorites: "favorites_store",
} as const;

const FAVORITE_KEYS = new Set([
  "favoriteSongs",
  "currentFavoriteIndex",
  "favoritePlayMode",
  "favoritePlaybackTime",
]);

function getTableForKey(key: string): keyof typeof TABLES {
  return FAVORITE_KEYS.has(key) ? TABLES.favorites : TABLES.playback;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// 创建表
async function ensureTables(env: Env) {
  const createStatements = [
    `CREATE TABLE IF NOT EXISTS playback_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS favorites_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const sql of createStatements) {
    try {
      console.log("Executing SQL:", sql);
      await env.DB.prepare(sql).run();
      console.log("SQL executed successfully");
    } catch (err) {
      console.error("Error executing SQL:", sql, err);
    }
  }
}

export async function onRequest(context: { request: Request; env: Env }) {
  const { request, env } = context;

  try {
    const method = (request.method || "GET").toUpperCase();

    // CORS 预检
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (!env.DB) return jsonResponse({ error: "D1 database not available" }, 500);

    // GET: 查询数据
    if (method === "GET") {
      const url = new URL(request.url);
      const keysParam = url.searchParams.get("keys") || "";
      const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);

      await ensureTables(env);

      const data: Record<string, string | null> = {};

      if (keys.length > 0) {
        for (const key of keys) {
          const table = getTableForKey(key);
          try {
            const res = await env.DB.prepare(`SELECT value FROM ${table} WHERE key=?`).bind(key).first();
            data[key] = res?.value ?? null;
          } catch (err) {
            console.error(`Error fetching key "${key}" from table "${table}":`, err);
            data[key] = null;
          }
        }
      } else {
        // 获取全部数据
        for (const table of Object.values(TABLES)) {
          try {
            const res = await env.DB.prepare(`SELECT key, value FROM ${table}`).all();
            (res.results || []).forEach((row: any) => (data[row.key] = row.value));
          } catch (err) {
            console.error(`Error fetching table "${table}":`, err);
          }
        }
      }

      return jsonResponse({ ok: true, data });
    }

    // POST: 写入数据
    if (method === "POST") {
      const text = await request.text();
      console.log("Raw POST body:", text);

      let body: JsonBody;
      try {
        body = JSON.parse(text);
      } catch (err) {
        console.error("Failed to parse JSON:", err);
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      const payload = body.data && typeof body.data === "object" ? body.data : null;
      if (!payload) return jsonResponse({ error: "Missing data" }, 400);

      await ensureTables(env);

      let updatedCount = 0;
      for (const [key, value] of Object.entries(payload)) {
        const table = getTableForKey(key);
        try {
          await env.DB.prepare(
            `INSERT INTO ${table} (key, value, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
          ).bind(key, String(value ?? "")).run();
          updatedCount++;
        } catch (err) {
          console.error(`Error inserting key "${key}" into table "${table}":`, err);
        }
      }

      return jsonResponse({ ok: true, updated: updatedCount });
    }

    // DELETE: 删除数据
    if (method === "DELETE") {
      const text = await request.text();
      let body: JsonBody = {};
      try {
        body = JSON.parse(text);
      } catch (err) {
        console.error("Failed to parse JSON for DELETE:", err);
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      const keys = Array.isArray(body.keys) ? body.keys : [];
      if (!keys.length) return jsonResponse({ ok: true, deleted: 0 });

      await ensureTables(env);

      let deletedCount = 0;
      for (const key of keys) {
        const table = getTableForKey(key);
        try {
          await env.DB.prepare(`DELETE FROM ${table} WHERE key=?`).bind(key).run();
          deletedCount++;
        } catch (err) {
          console.error(`Error deleting key "${key}" from table "${table}":`, err);
        }
      }

      return jsonResponse({ ok: true, deleted: deletedCount });
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("Global error in onRequest:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
}

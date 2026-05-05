import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "path";
import fs from "fs";
import { initDb } from "./db/schema";
import { queryGroups } from "./db/groups-repo";
import { getMarketsForGroup } from "./db/markets-repo";
import type { GroupsQuery } from "./db/groups-repo";

const PORT = parseInt(process.env.SERVER_PORT ?? "3001", 10);

async function start(): Promise<void> {
  const db = initDb();

  const fastify = Fastify({ logger: true });

  fastify.get("/api/groups", async (request) => {
    const q = request.query as Record<string, string | undefined>;

    const query: GroupsQuery = {};

    if (q.type !== undefined) {
      const parsed = parseInt(q.type, 10);
      if (!isNaN(parsed)) query.type = parsed;
    }
    if (q.profitable === "true") query.profitable = true;
    if (q.sortBy === "magnitude" || q.sortBy === "detected_at") query.sortBy = q.sortBy;
    if (q.sortDir === "asc" || q.sortDir === "desc") query.sortDir = q.sortDir;
    if (q.page !== undefined) {
      const parsed = parseInt(q.page, 10);
      if (!isNaN(parsed) && parsed > 0) query.page = parsed;
    }
    if (q.pageSize !== undefined) {
      const parsed = parseInt(q.pageSize, 10);
      if (!isNaN(parsed) && parsed > 0) query.pageSize = parsed;
    }

    return queryGroups(db, query);
  });

  fastify.get<{ Params: { id: string } }>("/api/groups/:id/markets", async (request) => {
    return getMarketsForGroup(db, request.params.id);
  });

  // Serve the Vite build in production (when client/dist exists)
  const clientDist = path.join(process.cwd(), "client", "dist");
  if (fs.existsSync(clientDist)) {
    await fastify.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
    });

    fastify.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile("index.html");
    });
  }

  await fastify.listen({ port: PORT, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

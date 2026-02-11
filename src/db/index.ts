import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { type Client, Pool } from "pg";

import * as schema from "./schema";

export type DbConnection = {
	pgClient: Client | Pool;
	db: NodePgDatabase<typeof schema>;
	/** このパッケージが接続を所有しているか（close責任があるか） */
	ownsConnection: boolean;
};

/**
 * databaseUrl から新しい pg.Pool を作成してDrizzleでラップする
 * 接続の所有権はこのパッケージに帰属する
 */
export function createDbConnection(databaseUrl: string): DbConnection {
	const pool = new Pool({ connectionString: databaseUrl });
	const db = drizzle(pool, { schema });
	return { pgClient: pool, db, ownsConnection: true };
}

/**
 * 外部の pg.Client または pg.Pool をDrizzleでラップする
 * 接続の所有権はホスト側に帰属（closeしない）
 */
export function wrapExternalClient(pgClient: Client | Pool): DbConnection {
	const db = drizzle(pgClient, { schema });
	return { pgClient, db, ownsConnection: false };
}

/**
 * 接続を確立する（Pool は疎通確認、Client は connect()）
 */
export async function connectDb(pgClient: Client | Pool) {
	// Pool は lazy connect。起動時に疎通だけ確認する。
	if (pgClient instanceof Pool) {
		const client = await pgClient.connect();
		client.release();
	} else {
		try {
			await pgClient.connect();
		} catch (error) {
			// 既に接続済みのClientが渡された場合はそのまま利用する
			if (
				error instanceof Error &&
				error.message.includes("Client has already been connected")
			) {
				return;
			}
			throw error;
		}
	}
}

export { schema };

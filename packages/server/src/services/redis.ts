import { db } from "@dokploy/server/db";
import { type apiCreateRedis, redis } from "@dokploy/server/db/schema";
import { buildAppName, cleanAppName } from "@dokploy/server/db/schema";
import { generatePassword } from "@dokploy/server/templates/utils";
import { buildRedis } from "@dokploy/server/utils/databases/redis";
import { pullImage } from "@dokploy/server/utils/docker/utils";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { validUniqueServerAppName } from "./project";

import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";

export type Redis = typeof redis.$inferSelect;

// https://github.com/drizzle-team/drizzle-orm/discussions/1483#discussioncomment-7523881
export const createRedis = async (input: typeof apiCreateRedis._type) => {
	const appName = buildAppName("redis", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newRedis = await db
		.insert(redis)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newRedis) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting redis database",
		});
	}

	return newRedis;
};

export const findRedisById = async (redisId: string) => {
	const result = await db.query.redis.findFirst({
		where: eq(redis.redisId, redisId),
		with: {
			project: true,
			mounts: true,
			server: true,
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Redis not found",
		});
	}
	return result;
};

export const updateRedisById = async (
	redisId: string,
	redisData: Partial<Redis>,
) => {
	const result = await db
		.update(redis)
		.set({
			...redisData,
			appName: cleanAppName(redisData.appName),
		})
		.where(eq(redis.redisId, redisId))
		.returning();

	return result[0];
};

export const removeRedisById = async (redisId: string) => {
	const result = await db
		.delete(redis)
		.where(eq(redis.redisId, redisId))
		.returning();

	return result[0];
};

export const deployRedis = async (redisId: string) => {
	const redis = await findRedisById(redisId);
	try {
		if (redis.serverId) {
			await execAsyncRemote(redis.serverId, `docker pull ${redis.dockerImage}`);
		} else {
			await pullImage(redis.dockerImage);
		}

		await buildRedis(redis);
		await updateRedisById(redisId, {
			applicationStatus: "done",
		});
	} catch (error) {
		await updateRedisById(redisId, {
			applicationStatus: "error",
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy redis${error}`,
		});
	}
	return redis;
};

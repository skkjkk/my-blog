import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";

const call = makeCaller(worker);

test("静态资源抛错时返回可重试的 500 JSON，而不是让请求崩掉", async () => {
	const env = createEnv({
		ASSETS: {
			fetch: () => {
				throw new Error("boom");
			},
		},
	});
	const originalError = console.error;
	console.error = () => {};
	try {
		const response = await call("/some-page/", {}, env);
		assert.equal(response.status, 500);
		const body = await response.json();
		assert.equal(body.retryable, true);
		assert.ok(typeof body.error === "string");
	} finally {
		console.error = originalError;
	}
});

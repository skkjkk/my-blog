import test from "node:test";
import assert from "node:assert/strict";
import {
	sha256Hex,
	hmacHex,
	timingSafeEqual,
	hashIp,
	identityHash,
	signIdentity,
	verifyIdentity,
	newUid,
} from "../../worker/lib/crypto.js";

test("sha256Hex 稳定", async () => {
	assert.equal((await sha256Hex("abc")).length, 64);
	assert.equal(await sha256Hex("abc"), await sha256Hex("abc"));
});

test("hmacHex 随密钥变化", async () => {
	const a = await hmacHex("s1", "abc");
	assert.equal(a.length, 64);
	assert.notEqual(a, await hmacHex("s2", "abc"));
});

test("hashIp 16 位且随 salt 变化", async () => {
	assert.equal((await hashIp("1.2.3.4", "s1")).length, 16);
	assert.notEqual(await hashIp("1.2.3.4", "s1"), await hashIp("1.2.3.4", "s2"));
});

test("identityHash 32 位", async () => {
	assert.equal((await identityHash("uid-1", "salt")).length, 32);
});

test("timingSafeEqual 等长比较", () => {
	assert.equal(timingSafeEqual("abcd", "abcd"), true);
	assert.equal(timingSafeEqual("abcd", "abce"), false);
	assert.equal(timingSafeEqual("ab", "abcd"), false);
});

test("身份 cookie 签验往返，篡改即失效", async () => {
	const token = await signIdentity({ uid: "u1", name: "小明" }, "secret");
	assert.deepEqual(await verifyIdentity(token, "secret"), { uid: "u1", name: "小明" });
	assert.equal(await verifyIdentity(token, "wrong"), null);
	const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
	assert.notEqual(tampered, token);
	assert.equal(await verifyIdentity(tampered, "secret"), null);
	assert.equal(await verifyIdentity("garbage", "secret"), null);
});

test("newUid 每次不同且为 32 位 hex", () => {
	const a = newUid();
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, newUid());
});

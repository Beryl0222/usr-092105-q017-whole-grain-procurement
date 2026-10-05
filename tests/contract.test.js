import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { validatePayload } from "../src/payloads.js";

test("中文样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
  assert.deepEqual(validatePayload(sample), []);
});

test("事件必须挂在对应的业务对象上", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  const wrong = { ...sample, aggregate_type: "purchase_contract" };
  assert.ok(validateEvent(wrong).some((msg) => msg.includes("应挂在 supply_batch 上")));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checkStream, traceOrder } from "../src/ledger.js";

async function loadScenario(name) {
  return JSON.parse(await readFile(new URL(`../data/scenarios/${name}`, import.meta.url), "utf8"));
}

test("全麦面包场景：差异签署接收、当天菜单更新、扣款定案，事件流通过", async () => {
  const events = await loadScenario("whole-wheat-bread.json");
  assert.deepEqual(checkStream(events), []);
});

test("杂粮替代场景：批准替代并当天更新菜单，事件流通过", async () => {
  const events = await loadScenario("multigrain-substitution.json");
  assert.deepEqual(checkStream(events), []);
});

test("付款审核可沿订单追到样品、批次、接收决定与扣款", async () => {
  const events = await loadScenario("whole-wheat-bread.json");
  const trace = traceOrder(events, "PO-1001");
  assert.deepEqual(trace.batches, ["B1001-01"]);
  assert.deepEqual(trace.samples, ["S-1001-01"]);
  assert.deepEqual(trace.decisions, ["evt-2026-A07"]);
  assert.deepEqual(trace.receipts, ["evt-2026-A08"]);
  assert.deepEqual(trace.deductions, ["evt-2026-A10"]);
});

test("实际接收后当天未更新菜单时报警", async () => {
  const events = (await loadScenario("whole-wheat-bread.json")).filter((e) => e.event_type !== "MENU_UPDATED");
  assert.ok(checkStream(events).some((msg) => msg.includes("当天未发布对应菜单更新")));
});

test("批准替代后未按供餐日更新菜单时报警", async () => {
  const events = (await loadScenario("multigrain-substitution.json")).filter((e) => e.event_type !== "MENU_UPDATED");
  assert.ok(checkStream(events).some((msg) => msg.includes("未发布说明声明变化的菜单更新")));
});

test("验收决定引用其他批次的样品时拒绝外推", async () => {
  const events = await loadScenario("whole-wheat-bread.json");
  const decision = events.find((e) => e.event_type === "ACCEPTANCE_DECIDED");
  decision.sample_ids = ["S-9999-99"];
  assert.ok(checkStream(events).some((msg) => msg.includes("没有抽样记录")));
});

test("标准与合同阈值不一致而缺少签署时报警", async () => {
  const events = await loadScenario("whole-wheat-bread.json");
  const decision = events.find((e) => e.event_type === "ACCEPTANCE_DECIDED");
  delete decision.divergence;
  assert.ok(checkStream(events).some((msg) => msg.includes("有权人员签署")));
});

test("补证或申诉不能改变已定案的范围", async () => {
  const events = await loadScenario("whole-wheat-bread.json");
  events.push({
    event_id: "evt-2026-A99",
    event_type: "APPEAL_FILED",
    aggregate_type: "purchase_contract",
    aggregate_id: "contract-wg-2026",
    occurred_at: "2026-09-22T09:00:00+08:00",
    version: 4,
    summary: "供应商对扣款决定提出申诉",
    target_decision_id: "evt-2026-A07",
    contested_scope: "批次 B1001-01 全部数量",
    reason: "供应商认为检测值四舍五入后应视为达标",
  });
  assert.ok(checkStream(events).some((msg) => msg.includes("尚未定案")));
});

test("决定未定案前允许补证", async () => {
  const events = (await loadScenario("whole-wheat-bread.json")).filter((e) => e.event_type !== "DEDUCTION_APPLIED");
  events.push({
    event_id: "evt-2026-A98",
    event_type: "EVIDENCE_SUPPLEMENTED",
    aggregate_type: "purchase_contract",
    aggregate_id: "contract-wg-2026",
    occurred_at: "2026-09-21T09:30:00+08:00",
    version: 3,
    summary: "供应商补充本批次配方证明原件",
    target_decision_id: "evt-2026-A07",
    contested_scope: "批次 B1001-01 配方证明",
    evidence_ref: "FC-8817-original",
  });
  assert.deepEqual(checkStream(events), []);
});

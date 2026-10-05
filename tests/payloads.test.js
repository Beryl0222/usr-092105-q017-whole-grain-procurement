import assert from "node:assert/strict";
import test from "node:test";

import { validatePayload } from "../src/payloads.js";

const base = {
  event_id: "evt-test-0001",
  aggregate_id: "X-1",
  occurred_at: "2026-09-20T08:00:00+08:00",
  version: 1,
  summary: "测试事件",
};

test("配方证明对应上一生产批次时拒绝到货登记", () => {
  const event = {
    ...base,
    event_type: "BATCH_DELIVERED",
    aggregate_type: "supply_batch",
    order_id: "PO-1",
    production_batch_no: "B-02",
    product_category: "全麦面包",
    formula_cert: { cert_id: "FC-1", covers_batch_no: "B-01" },
    processing_info: "低温烘焙",
    arrived_qty: 100,
    unit: "个",
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("不一致")));
});

test("检测结论不可外推全部产品", () => {
  const event = {
    ...base,
    event_type: "TEST_RESULT_RECORDED",
    aggregate_type: "acceptance_sample",
    batch_id: "B-02",
    items: [
      { name: "whole_grain_content", value: 0.55, standard_threshold: 0.5, contract_threshold: 0.6, passed_standard: true, passed_contract: false },
    ],
    conclusion_scope: "all_products",
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("不可外推")));
});

test("整批报废必须给出覆盖整批的依据", () => {
  const event = {
    ...base,
    event_type: "ACCEPTANCE_DECIDED",
    aggregate_type: "supply_batch",
    order_id: "PO-1",
    sample_ids: ["S-1"],
    disposition: "reject_all",
    affected_qty: 100,
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("整批报废")));
});

test("差异记录必须由有权人员签署", () => {
  const event = {
    ...base,
    event_type: "ACCEPTANCE_DECIDED",
    aggregate_type: "supply_batch",
    order_id: "PO-1",
    sample_ids: ["S-1"],
    disposition: "accept",
    affected_qty: 100,
    divergence: { note: "达到国标未达合同阈值" },
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("signed_by")));
});

test("接收与隔离数量不能超过到货数量", () => {
  const event = {
    ...base,
    event_type: "RECEIPT_CONFIRMED",
    aggregate_type: "supply_batch",
    cafeteria_id: "F01",
    order_id: "PO-1",
    received_qty: 100,
    accepted_qty: 90,
    isolated_qty: 20,
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("不能超过到货数量")));
});

test("菜单更新必须说明声明变化原因", () => {
  const event = {
    ...base,
    event_type: "MENU_UPDATED",
    aggregate_type: "menu_release",
    serving_date: "2026-09-21",
    cafeteria_id: "F01",
    basis: { type: "receipt", ref_id: "evt-x-0001" },
    claims: ["今日主食：杂粮饭"],
    claim_change_reason: "",
  };
  assert.ok(validatePayload(event).some((msg) => msg.includes("声明变化原因")));
});

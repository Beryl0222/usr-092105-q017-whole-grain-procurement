import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { project, projectAsOf } from "../src/projection.js";
import { audit, gate, replay } from "../src/rules.js";
import { validateEvent, validateStream } from "../src/validator.js";

const T = "2026-10-05T07:00:00+08:00";

let seq = 0;
function eid(prefix) {
  seq += 1;
  return `evt-test-${prefix}-${String(seq).padStart(3, "0")}`;
}

function ev(type, aggregateType, aggregateId, version, occurredAt, summary, payload) {
  return { event_id: eid(type), event_type: type, aggregate_type: aggregateType, aggregate_id: aggregateId, occurred_at: occurredAt, version, summary, payload };
}

/** 构造一个证据链完整的合格批次事件流，测试时按需增删改。 */
function happyBatch({ batchNo = "B1", sku = "SKU1", orderNo = "PO1", certBatch = batchNo } = {}) {
  return [
    ev("TENDER_DEFINED", "purchase_contract", "C1", 1, "2026-09-01T09:00:00+08:00", "招标", {
      tender_id: "T1",
      title: "测试招标",
      product_requirements: [{ sku, name: "测试品", metrics: [{ name: "全谷物比例", min: 30, max: 100, unit: "%", source: "standard" }] }],
    }),
    ev("CONTRACT_TERMS_EFFECTIVE", "purchase_contract", "C1", 2, "2026-09-02T09:00:00+08:00", "条款", {
      contract_no: "HT1",
      supplier_id: "S1",
      effective_from: "2026-09-02T00:00:00+08:00",
      effective_to: "2026-12-31T23:59:59+08:00",
      terms_snapshot: { terms_version: "v1", thresholds: [{ sku, name: "全谷物比例", min: 30, max: 100, unit: "%", source: "contract" }] },
    }),
    ev("ORDER_PLACED", "purchase_contract", "C1", 3, "2026-10-04T15:00:00+08:00", "下单", {
      order_no: orderNo, placed_at: "2026-10-04T15:00:00+08:00", terms_version: "v1", items: [{ sku, quantity: 100 }],
    }),
    ev("CATEGORY_REGISTERED", "supply_batch", `sku:${sku}`, 1, "2026-09-03T09:00:00+08:00", "品类", {
      sku, category: "谷物制品", whole_grain_claim: "全谷物≥30%",
    }),
    ev("RECIPE_CERTIFIED", "supply_batch", `sku:${sku}`, 2, "2026-09-03T09:30:00+08:00", "配方", {
      recipe_id: "R1", sku, formula_version: "v1",
      ingredient_certs: [{ cert_no: "CERT1", ingredient: "杂粮", covered_batch_nos: [certBatch] }],
    }),
    ev("BATCH_PRODUCED", "supply_batch", `batch:${batchNo}`, 1, "2026-10-04T22:00:00+08:00", "生产", {
      batch_no: batchNo, sku, produced_at: "2026-10-04T22:00:00+08:00", quantity: 100,
    }),
    ev("SAMPLING_PLAN_SET", "supply_batch", `batch:${batchNo}`, 2, "2026-10-04T22:10:00+08:00", "抽样方案", {
      batch_no: batchNo, plan: { standard: "抽检细则", sample_count: 3, points: ["成品库"], items: ["全谷物比例"] },
    }),
    ev("BATCH_DELIVERED", "supply_batch", `batch:${batchNo}`, 3, "2026-10-05T06:30:00+08:00", "到货", {
      batch_no: batchNo, order_no: orderNo, delivered_at: "2026-10-05T06:30:00+08:00", delivered_quantity: 100,
    }),
    ev("SAMPLE_COLLECTED", "acceptance_sample", "sample:S1", 1, "2026-10-05T06:40:00+08:00", "抽样", {
      sample_no: "S1", batch_no: batchNo, collected_at: "2026-10-05T06:40:00+08:00",
    }),
    ev("TEST_RESULT_RECORDED", "acceptance_sample", "sample:S1", 2, "2026-10-05T07:00:00+08:00", "检测合格", {
      sample_no: "S1", test_no: "R1", issued_at: T, conclusion: "qualified",
      items: [{ name: "全谷物比例", value: 35, unit: "%", conclusion: "qualified" }],
    }),
  ];
}

function codes(findings) {
  return new Set(findings.map((f) => f.code));
}

/* ------------------------------ 信封校验 ------------------------------ */

test("中文单条样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件类型必须挂在目录指定的聚合上，payload 必填字段齐备", () => {
  const bad = ev("SAMPLE_COLLECTED", "supply_batch", "x", 1, T, "挂错聚合", { sample_no: "S1" });
  const errs = validateEvent(bad);
  assert.ok(errs.some((m) => m.includes("只能挂在聚合 acceptance_sample")));
  assert.ok(errs.some((m) => m.includes("payload 缺少字段：batch_no")));

  const good = ev("SAMPLE_COLLECTED", "acceptance_sample", "x", 1, T, "抽样", {
    sample_no: "S1", batch_no: "B1", collected_at: T,
  });
  assert.deepEqual(validateEvent(good), []);
});

test("validateStream 检查版本连续、event_id 不重复", () => {
  const a = ev("BATCH_PRODUCED", "supply_batch", "batch:B1", 1, T, "生产", { batch_no: "B1", sku: "S", produced_at: T, quantity: 1 });
  const b = ev("BATCH_DELIVERED", "supply_batch", "batch:B1", 3, T, "跳号", { batch_no: "B1", order_no: "P", delivered_at: T, delivered_quantity: 1 });
  const dup = { ...a, event_id: a.event_id };
  const errs = validateStream([a, b, dup]);
  assert.ok(errs.some((m) => m.includes("版本不连续")));
  assert.ok(errs.some((m) => m.includes("event_id 重复")));
});

/* --------------------------- 招标/订单条款冻结 --------------------------- */

test("订单只能引用下单当时有效的条款版本", () => {
  const base = happyBatch();
  const state = project(base.slice(0, 2)); // 只有招标+条款
  const orderOutsideWindow = ev("ORDER_PLACED", "purchase_contract", "C1", 3, "2027-01-05T15:00:00+08:00", "条款过期后下单", {
    order_no: "PO-LATE", placed_at: "2027-01-05T15:00:00+08:00", terms_version: "v1", items: [],
  });
  assert.ok(codes(gate(orderOutsideWindow, state)).has("ORDER_TERMS_NOT_EFFECTIVE"));

  const orderUnknownVersion = ev("ORDER_PLACED", "purchase_contract", "C1", 3, "2026-10-04T15:00:00+08:00", "引用不存在版本", {
    order_no: "PO-X", placed_at: "2026-10-04T15:00:00+08:00", terms_version: "v999", items: [],
  });
  assert.ok(codes(gate(orderUnknownVersion, state)).has("ORDER_TERMS_UNKNOWN"));
});

/* ----------------------------- 本周两案例 ----------------------------- */

test("场景回放：headline 最终零阻断，阈值差异保留为已签署警示；检查点在补证前阻断", async () => {
  const data = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));
  const stream = data.streams.headline;
  assert.deepEqual(validateStream(stream), []);

  const { findings } = replay(stream);
  const found = codes(findings);
  for (const code of data.final_expect.headline.error_codes) assert.ok(!found.has(code), `不应出现阻断 ${code}`);
  for (const code of data.final_expect.headline.warning_codes) assert.ok(found.has(code), `应出现警示 ${code}`);
  assert.deepEqual([...found].filter((c) => !["THRESHOLD_MISMATCH_SIGNED"].includes(c)), []);

  const stateAt = projectAsOf(stream, "2026-10-05T07:14:00+08:00");
  assert.ok(codes(audit(stateAt)).has("CERT_BATCH_MISMATCH"));
});

test("场景回放：替代已批准但菜单仍挂原承诺且不更新 → 双重阻断", async () => {
  const data = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));
  const { findings } = replay(data.streams.stale_menu_after_substitution);
  const found = codes(findings);
  assert.ok(found.has("MENU_CLAIM_STALE"));
  assert.ok(found.has("MENU_NOT_UPDATED"));
  assert.deepEqual([...found].filter((c) => c !== "MENU_CLAIM_STALE" && c !== "MENU_NOT_UPDATED"), []);
});

/* --------------------------- 证明不得跨批次顶替 --------------------------- */

test("原料证明只覆盖上一个生产批次时，不得作为本批次接收依据；补证后解除", () => {
  const events = happyBatch({ batchNo: "B20261005", certBatch: "B20260920" });
  const before = audit(project(events));
  assert.ok(codes(before).has("CERT_BATCH_MISMATCH"));

  events.push(
    ev("SUPPLEMENT_DOCUMENTED", "supply_batch", "batch:B20261005", 4, "2026-10-05T07:15:00+08:00", "补证", {
      batch_no: "B20261005", doc_type: "ingredient_cert", submitted_at: "2026-10-05T07:15:00+08:00",
      detail: { covers_cert_no: "CERT1", covered_batch_nos: ["B20261005"] },
    }),
  );
  assert.ok(!codes(audit(project(events))).has("CERT_BATCH_MISMATCH"));
});

/* --------------------------- 检测结论不得外推 --------------------------- */

test("接收决定引用其他批次的样品 → SAMPLE_SCOPE_LEAK", () => {
  const events = happyBatch({ batchNo: "BA" });
  events.push(
    ev("BATCH_PRODUCED", "supply_batch", "batch:BB", 1, "2026-10-04T22:00:00+08:00", "另一批次生产", {
      batch_no: "BB", sku: "SKU1", produced_at: "2026-10-04T22:00:00+08:00", quantity: 50,
    }),
    ev("BATCH_DELIVERED", "supply_batch", "batch:BB", 2, "2026-10-05T06:31:00+08:00", "BB 到货", {
      batch_no: "BB", order_no: "PO1", delivered_at: "2026-10-05T06:31:00+08:00", delivered_quantity: 50,
    }),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:BB", 3, "2026-10-05T07:05:00+08:00", "借 BA 的样品结论接收 BB", {
      batch_no: "BB", decision: "accepted", decided_by: "某人", decided_at: "2026-10-05T07:05:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 50,
    }),
  );
  assert.ok(codes(audit(project(events))).has("SAMPLE_SCOPE_LEAK"));
});

/* ----------------------------- 局部不合格处置 ----------------------------- */

test("不得无依据整批报废；局部不合格只能隔离/换货", () => {
  const events = happyBatch();
  events.push(
    ev("TEST_RESULT_RECORDED", "acceptance_sample", "sample:S1", 3, "2026-10-05T07:05:00+08:00", "出现不合格项", {
      sample_no: "S1", test_no: "R2", issued_at: "2026-10-05T07:05:00+08:00", conclusion: "unqualified",
      items: [{ name: "全谷物比例", value: 20, unit: "%", conclusion: "unqualified" }],
    }),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "无依据整批拒收", {
      batch_no: "B1", decision: "rejected", decided_by: "某人", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], scrap_quantity: 100,
    }),
  );
  assert.ok(codes(audit(project(events))).has("SCRAP_WITHOUT_BASIS"));
});

test("局部接收登记隔离数量，换货不得超出隔离范围", () => {
  const events = happyBatch();
  events.push(
    ev("TEST_RESULT_RECORDED", "acceptance_sample", "sample:S1", 3, "2026-10-05T07:05:00+08:00", "局部不合格", {
      sample_no: "S1", test_no: "R2", issued_at: "2026-10-05T07:05:00+08:00", conclusion: "partial",
      items: [{ name: "全谷物比例", value: 33, unit: "%", conclusion: "qualified" }],
    }),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "局部接收", {
      batch_no: "B1", decision: "partial_accepted", decided_by: "李验收", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 90, isolated_quantity: 10,
    }),
    ev("RETURN_EXCHANGE_RECORDED", "supply_batch", "batch:B1", 5, "2026-10-05T08:00:00+08:00", "超出隔离范围换货", {
      record_no: "RT1", batch_no: "B1", type: "exchange", quantity: 20, reason: "多退",
    }),
  );
  assert.ok(codes(audit(project(events))).has("RETURN_SCOPE_EXCEEDED"));
});

/* --------------------------- 阈值差异须有权签署 --------------------------- */

test("标准与合同阈值不一致且未签署 → 阻断；越权签署同样阻断", () => {
  const events = happyBatch();
  events[0].payload.product_requirements[0].metrics[0].min = 40; // 标准 ≥40
  events.push(
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "未签署差异即接收", {
      batch_no: "B1", decision: "accepted", decided_by: "李验收", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 100,
    }),
  );
  assert.ok(codes(audit(project(events))).has("THRESHOLD_MISMATCH_UNSIGNED"));

  events[events.length - 1].payload.threshold_signoff = { by: "司机", role: "配送司机", at: T };
  assert.ok(codes(audit(project(events))).has("SIGNOFF_UNAUTHORIZED"));
});

/* ------------------------------- 定案锁定 ------------------------------- */

test("补证与申诉只能改变尚未定案的批次", () => {
  const events = happyBatch();
  events.push(
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "定案接收", {
      batch_no: "B1", decision: "accepted", decided_by: "李验收", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 100, finalized: true,
    }),
  );
  const state = project(events);

  const supplement = ev("SUPPLEMENT_DOCUMENTED", "supply_batch", "batch:B1", 5, "2026-10-06T09:00:00+08:00", "定案后补证", {
    batch_no: "B1", doc_type: "ingredient_cert", submitted_at: "2026-10-06T09:00:00+08:00",
  });
  assert.ok(codes(gate(supplement, state)).has("SUPPLEMENT_AFTER_FINALIZED"));

  const appeal = ev("APPEAL_DECIDED", "supply_batch", "batch:B1", 5, "2026-10-06T10:00:00+08:00", "定案后申诉", {
    batch_no: "B1", appeal_no: "A1", decided_by: "裁决组", decided_at: "2026-10-06T10:00:00+08:00", result: "uphold",
  });
  assert.ok(codes(gate(appeal, state)).has("APPEAL_AFTER_FINALIZED"));
});

/* ------------------------------- 付款追溯 ------------------------------- */

test("整批合格接收后扣款无依据；扣款数量不得超过未接收数量", () => {
  const accepted = project([
    ...happyBatch(),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "整批接收", {
      batch_no: "B1", decision: "accepted", decided_by: "李验收", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 100,
    }),
  ]);
  const deductFromAccepted = ev("DEDUCTION_RECORDED", "supply_batch", "batch:B1", 5, "2026-10-05T09:00:00+08:00", "扣款", {
    deduction_no: "DK1", order_no: "PO1", batch_no: "B1", amount: 50, quantity: 10, reason: "无依据",
  });
  assert.ok(codes(gate(deductFromAccepted, accepted)).has("PAY_DEDUCT_FROM_ACCEPTED"));

  const partial = project([
    ...happyBatch(),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:10:00+08:00", "局部接收 90", {
      batch_no: "B1", decision: "partial_accepted", decided_by: "李验收", decided_at: "2026-10-05T07:10:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 90, isolated_quantity: 10,
    }),
  ]);
  const overDeduct = ev("DEDUCTION_RECORDED", "supply_batch", "batch:B1", 5, "2026-10-05T09:00:00+08:00", "超额扣款", {
    deduction_no: "DK2", order_no: "PO1", batch_no: "B1", amount: 999, quantity: 30, reason: "超量",
  });
  assert.ok(codes(gate(overDeduct, partial)).has("PAY_QTY_EXCEEDED"));
});

/* --------------------------- 替代与菜单时效 --------------------------- */

test("替代供货必须凭已批准申请，且 SKU 与批准一致", () => {
  const base = happyBatch({ batchNo: "B1", sku: "SKU2" });
  base.push(
    ev("SUBSTITUTION_REQUESTED", "supply_batch", "request:RQ1", 1, "2026-10-05T06:32:00+08:00", "申请替代", {
      request_no: "RQ1", order_no: "PO1", original_sku: "SKU1", substitute_sku: "SKU2", reason: "缺货",
    }),
  );
  const state = project(base);
  const delivery = ev("BATCH_DELIVERED", "supply_batch", "batch:B1", 3, "2026-10-05T06:55:00+08:00", "凭未批准申请送货", {
    batch_no: "B1", order_no: "PO1", against_request_no: "RQ1", delivered_at: "2026-10-05T06:55:00+08:00", delivered_quantity: 100,
  });
  assert.ok(codes(gate(delivery, state)).has("DELIVERY_SUB_NOT_APPROVED"));
});

test("接收后菜单超过 30 分钟才更新 → MENU_UPDATE_LATE", () => {
  const events = [
    ...happyBatch(),
    ev("ACCEPTANCE_DECIDED", "supply_batch", "batch:B1", 4, "2026-10-05T07:30:00+08:00", "接收", {
      batch_no: "B1", decision: "accepted", decided_by: "李验收", decided_at: "2026-10-05T07:30:00+08:00",
      based_on_samples: ["S1"], accepted_quantity: 100,
    }),
    ev("MENU_RELEASED", "menu_release", "menu:M1", 1, "2026-10-04T18:00:00+08:00", "发布菜单", {
      menu_id: "M1", serving_date: "2026-10-05",
      items: [{ sku: "SKU1", name: "杂粮饭", claim: "全谷物≥30%", order_no: "PO1" }],
      claims: ["全谷物≥30%"],
    }),
    ev("MENU_UPDATED", "menu_release", "menu:M1", 2, "2026-10-05T09:00:00+08:00", "90 分钟后才更新", {
      menu_id: "M1", updated_at: "2026-10-05T09:00:00+08:00",
      items: [{ sku: "SKU1", name: "杂粮饭", claim: "全谷物≥30%", order_no: "PO1" }],
      claims: ["全谷物≥30%"], change_reason: "按实际接收更新",
    }),
  ];
  assert.ok(codes(audit(project(events))).has("MENU_UPDATE_LATE"));
});

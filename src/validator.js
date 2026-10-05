export const AGGREGATE_TYPES = ["purchase_contract", "supply_batch", "acceptance_sample", "menu_release"];

export const EVENT_TYPES = [
  "TENDER_DEFINED",
  "TERMS_LOCKED",
  "BATCH_DELIVERED",
  "SAMPLING_PLAN_ISSUED",
  "SAMPLE_COLLECTED",
  "TEST_RESULT_RECORDED",
  "ACCEPTANCE_DECIDED",
  "RECEIPT_CONFIRMED",
  "RETURN_RECORDED",
  "SUBSTITUTION_REQUESTED",
  "SUBSTITUTION_APPROVED",
  "MENU_UPDATED",
  "DEDUCTION_APPLIED",
  "APPEAL_FILED",
  "EVIDENCE_SUPPLEMENTED",
];

/** 每类事件只允许挂在对应的业务对象上。 */
export const EVENT_AGGREGATE = {
  TENDER_DEFINED: "purchase_contract",
  TERMS_LOCKED: "purchase_contract",
  SUBSTITUTION_REQUESTED: "purchase_contract",
  SUBSTITUTION_APPROVED: "purchase_contract",
  DEDUCTION_APPLIED: "purchase_contract",
  APPEAL_FILED: "purchase_contract",
  EVIDENCE_SUPPLEMENTED: "purchase_contract",
  BATCH_DELIVERED: "supply_batch",
  ACCEPTANCE_DECIDED: "supply_batch",
  RECEIPT_CONFIRMED: "supply_batch",
  RETURN_RECORDED: "supply_batch",
  SAMPLING_PLAN_ISSUED: "acceptance_sample",
  SAMPLE_COLLECTED: "acceptance_sample",
  TEST_RESULT_RECORDED: "acceptance_sample",
  MENU_UPDATED: "menu_release",
};

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 信封级校验，返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知业务对象类型：${record.aggregate_type}`);
  const expected = EVENT_AGGREGATE[record.event_type];
  if (expected && "aggregate_type" in record && record.aggregate_type !== expected) {
    errors.push(`事件 ${record.event_type} 应挂在 ${expected} 上，而不是 ${record.aggregate_type}`);
  }
  return errors;
}

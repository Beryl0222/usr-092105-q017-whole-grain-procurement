import { validateEvent } from "./validator.js";
import { validatePayload } from "./payloads.js";

const dateOf = (event) => event.occurred_at.slice(0, 10);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * 事件流级校验：把同一条业务链上的事件放在一起检查跨事件约束。
 * 返回中文错误列表，空数组表示通过。
 */
export function checkStream(events) {
  const errors = [];
  for (const event of events) {
    for (const msg of [...validateEvent(event), ...validatePayload(event)]) {
      errors.push(`${event.event_id ?? "未知事件"}：${msg}`);
    }
  }
  if (errors.length > 0) return errors;

  const byId = new Map(events.map((e) => [e.event_id, e]));
  const delivered = new Set(events.filter((e) => e.event_type === "BATCH_DELIVERED").map((e) => e.aggregate_id));

  // 样品与其批次：检测结论只覆盖对应样品和批次
  const sampleBatch = new Map();
  const resultsBySample = new Map();
  for (const e of events) {
    if (e.event_type === "SAMPLE_COLLECTED") sampleBatch.set(e.aggregate_id, e.batch_id);
    if (e.event_type === "TEST_RESULT_RECORDED") {
      if (!resultsBySample.has(e.aggregate_id)) resultsBySample.set(e.aggregate_id, []);
      resultsBySample.get(e.aggregate_id).push(e);
    }
  }

  // 已定案范围：显式 final 的决定，以及已被扣款引用的决定
  const finalized = new Set();
  for (const e of events) {
    if (e.event_type === "ACCEPTANCE_DECIDED" && e.final === true) finalized.add(e.event_id);
    if (e.event_type === "DEDUCTION_APPLIED") finalized.add(e.linked_decision_id);
  }

  for (const e of events) {
    if (e.event_type === "ACCEPTANCE_DECIDED") {
      if (!delivered.has(e.aggregate_id)) {
        errors.push(`${e.event_id}：验收决定针对的批次 ${e.aggregate_id} 没有到货记录`);
      }
      for (const sampleId of e.sample_ids) {
        if (!sampleBatch.has(sampleId)) {
          errors.push(`${e.event_id}：验收决定引用的样品 ${sampleId} 没有抽样记录`);
        } else if (sampleBatch.get(sampleId) !== e.aggregate_id) {
          errors.push(`${e.event_id}：样品 ${sampleId} 属于批次 ${sampleBatch.get(sampleId)}，检测结论不可外推到批次 ${e.aggregate_id}`);
        }
      }
      const divergent = e.sample_ids
        .flatMap((id) => resultsBySample.get(id) ?? [])
        .flatMap((r) => r.items)
        .some((item) => item.passed_standard !== item.passed_contract);
      if (divergent && !(e.divergence && isStr(e.divergence.note) && isStr(e.divergence.signed_by))) {
        errors.push(`${e.event_id}：标准与合同阈值结论不一致，须提示差异并由有权人员签署接收`);
      }
    }

    if (e.event_type === "RECEIPT_CONFIRMED" && !delivered.has(e.aggregate_id)) {
      errors.push(`${e.event_id}：食堂接收的批次 ${e.aggregate_id} 没有到货记录`);
    }

    if (e.event_type === "SUBSTITUTION_APPROVED") {
      const request = byId.get(e.request_id);
      if (!request || request.event_type !== "SUBSTITUTION_REQUESTED") {
        errors.push(`${e.event_id}：替代批准缺少对应的替代申请`);
      }
    }

    if (e.event_type === "APPEAL_FILED" || e.event_type === "EVIDENCE_SUPPLEMENTED") {
      if (!byId.has(e.target_decision_id)) {
        errors.push(`${e.event_id}：补证或申诉针对的验收决定 ${e.target_decision_id} 不存在`);
      } else if (finalized.has(e.target_decision_id)) {
        errors.push(`${e.event_id}：补证或申诉只能改变尚未定案的范围，决定 ${e.target_decision_id} 已定案`);
      }
    }
  }

  // 当天菜单必须随实际接收或批准替代立即更新
  const menus = events.filter((e) => e.event_type === "MENU_UPDATED");
  for (const e of events) {
    if (e.event_type === "RECEIPT_CONFIRMED") {
      const day = dateOf(e);
      const covered = menus.some((m) => m.cafeteria_id === e.cafeteria_id && m.serving_date === day && dateOf(m) === day);
      if (!covered) errors.push(`${e.event_id}：食堂 ${e.cafeteria_id} 在 ${day} 实际接收后，当天未发布对应菜单更新`);
    }
    if (e.event_type === "SUBSTITUTION_APPROVED") {
      const covered = menus.some((m) => m.basis.type === "substitution" && m.basis.ref_id === e.event_id && m.serving_date === e.serving_date);
      if (!covered) errors.push(`${e.event_id}：批准替代后，供餐日 ${e.serving_date} 未发布说明声明变化的菜单更新`);
    }
  }

  return errors;
}

/** 付款审核追溯：沿订单汇集批次、样品、验收决定、接收与扣款。 */
export function traceOrder(events, orderId) {
  const batches = events.filter((e) => e.event_type === "BATCH_DELIVERED" && e.order_id === orderId).map((e) => e.aggregate_id);
  const batchSet = new Set(batches);
  const samples = events.filter((e) => e.aggregate_type === "acceptance_sample" && batchSet.has(e.batch_id)).map((e) => e.aggregate_id);
  return {
    order_id: orderId,
    contract_events: events.filter((e) => e.aggregate_type === "purchase_contract" && e.order_id === orderId).map((e) => e.event_id),
    batches,
    samples: [...new Set(samples)],
    decisions: events.filter((e) => e.event_type === "ACCEPTANCE_DECIDED" && batchSet.has(e.aggregate_id)).map((e) => e.event_id),
    receipts: events.filter((e) => e.event_type === "RECEIPT_CONFIRMED" && batchSet.has(e.aggregate_id)).map((e) => e.event_id),
    returns: events.filter((e) => e.event_type === "RETURN_RECORDED" && batchSet.has(e.aggregate_id)).map((e) => e.event_id),
    deductions: events.filter((e) => e.event_type === "DEDUCTION_APPLIED" && e.order_id === orderId).map((e) => e.event_id),
  };
}

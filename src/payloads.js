const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isPosNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isNonEmptyArr = (v) => Array.isArray(v) && v.length > 0;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 局部不合格时的允许处置方式；reject_all 必须另附整批依据。 */
export const DISPOSITIONS = ["accept", "isolate_partial", "replenish", "menu_change", "return_partial", "reject_all"];

function missing(record, fields) {
  return fields.filter((f) => !(f in record)).map((f) => `缺少字段：${f}`);
}

const checkers = {
  TENDER_DEFINED(r) {
    const errors = missing(r, ["tender_id", "product_category", "standard_refs", "claim_items", "contract_thresholds"]);
    if ("standard_refs" in r && !isNonEmptyArr(r.standard_refs)) errors.push("standard_refs 必须是非空数组");
    if ("claim_items" in r && !isNonEmptyArr(r.claim_items)) errors.push("claim_items 必须是非空数组");
    if ("contract_thresholds" in r && !isObj(r.contract_thresholds)) errors.push("contract_thresholds 必须是对象");
    return errors;
  },

  TERMS_LOCKED(r) {
    const errors = missing(r, ["order_id", "tender_id", "terms_snapshot"]);
    if ("terms_snapshot" in r && (!isObj(r.terms_snapshot) || Object.keys(r.terms_snapshot).length === 0)) {
      errors.push("terms_snapshot 必须保存订单当时有效条款，不能是空对象");
    }
    return errors;
  },

  BATCH_DELIVERED(r) {
    const errors = missing(r, ["order_id", "production_batch_no", "product_category", "formula_cert", "processing_info", "arrived_qty", "unit"]);
    if ("arrived_qty" in r && !isPosNum(r.arrived_qty)) errors.push("arrived_qty 必须是正数");
    if ("formula_cert" in r) {
      if (!isObj(r.formula_cert) || !isStr(r.formula_cert.cert_id) || !isStr(r.formula_cert.covers_batch_no)) {
        errors.push("formula_cert 必须包含 cert_id 与 covers_batch_no");
      } else if ("production_batch_no" in r && r.formula_cert.covers_batch_no !== r.production_batch_no) {
        errors.push(`配方证明对应批次（${r.formula_cert.covers_batch_no}）与生产批次（${r.production_batch_no}）不一致`);
      }
    }
    return errors;
  },

  SAMPLING_PLAN_ISSUED(r) {
    const errors = missing(r, ["batch_id", "plan"]);
    if ("plan" in r) {
      if (!isObj(r.plan) || !isStr(r.plan.method) || !isPosNum(r.plan.sample_size) || !isNonEmptyArr(r.plan.items)) {
        errors.push("plan 必须包含 method、正数 sample_size 与非空 items");
      }
    }
    return errors;
  },

  SAMPLE_COLLECTED(r) {
    const errors = missing(r, ["batch_id", "plan_id", "sample_qty", "collected_by"]);
    if ("sample_qty" in r && !isPosNum(r.sample_qty)) errors.push("sample_qty 必须是正数");
    return errors;
  },

  TEST_RESULT_RECORDED(r) {
    const errors = missing(r, ["batch_id", "items", "conclusion_scope"]);
    if ("conclusion_scope" in r && r.conclusion_scope !== "sample_and_batch_only") {
      errors.push("检测结论只能覆盖对应样品和批次，不可外推全部产品");
    }
    if ("items" in r) {
      if (!isNonEmptyArr(r.items)) {
        errors.push("items 必须是非空数组");
      } else {
        r.items.forEach((item, i) => {
          const ok = isObj(item) && isStr(item.name) && typeof item.value === "number"
            && "standard_threshold" in item && "contract_threshold" in item
            && typeof item.passed_standard === "boolean" && typeof item.passed_contract === "boolean";
          if (!ok) errors.push(`items[${i}] 必须包含 name、value、standard_threshold、contract_threshold、passed_standard、passed_contract`);
        });
      }
    }
    return errors;
  },

  ACCEPTANCE_DECIDED(r) {
    const errors = missing(r, ["order_id", "sample_ids", "disposition", "affected_qty"]);
    if ("sample_ids" in r && !isNonEmptyArr(r.sample_ids)) errors.push("sample_ids 必须是非空数组");
    if ("disposition" in r && !DISPOSITIONS.includes(r.disposition)) errors.push(`disposition 必须是：${DISPOSITIONS.join("、")}`);
    if ("affected_qty" in r && !isPosNum(r.affected_qty)) errors.push("affected_qty 必须是正数");
    if (r.disposition === "reject_all" && !isStr(r.whole_batch_justification)) {
      errors.push("整批报废必须给出覆盖整批的依据，不能凭局部结果无依据报废");
    }
    if ("divergence" in r && (!isObj(r.divergence) || !isStr(r.divergence.note) || !isStr(r.divergence.signed_by))) {
      errors.push("divergence 必须包含差异说明 note 与有权签署人 signed_by");
    }
    return errors;
  },

  RECEIPT_CONFIRMED(r) {
    const errors = missing(r, ["cafeteria_id", "order_id", "received_qty", "accepted_qty", "isolated_qty"]);
    if ("received_qty" in r && !isPosNum(r.received_qty)) errors.push("received_qty 必须是正数");
    if ("accepted_qty" in r && !isNonNegNum(r.accepted_qty)) errors.push("accepted_qty 必须是非负数");
    if ("isolated_qty" in r && !isNonNegNum(r.isolated_qty)) errors.push("isolated_qty 必须是非负数");
    if (isPosNum(r.received_qty) && isNonNegNum(r.accepted_qty) && isNonNegNum(r.isolated_qty)
      && r.accepted_qty + r.isolated_qty > r.received_qty) {
      errors.push("接收与隔离数量之和不能超过到货数量");
    }
    return errors;
  },

  RETURN_RECORDED(r) {
    const errors = missing(r, ["order_id", "qty", "reason", "linked_decision_id"]);
    if ("qty" in r && !isPosNum(r.qty)) errors.push("qty 必须是正数");
    return errors;
  },

  SUBSTITUTION_REQUESTED(r) {
    return missing(r, ["order_id", "original_item", "proposed_item", "reason"]);
  },

  SUBSTITUTION_APPROVED(r) {
    return missing(r, ["request_id", "order_id", "approved_by", "serving_date"]);
  },

  MENU_UPDATED(r) {
    const errors = missing(r, ["serving_date", "cafeteria_id", "basis", "claims", "claim_change_reason"]);
    if ("basis" in r) {
      if (!isObj(r.basis) || !["receipt", "substitution"].includes(r.basis.type) || !isStr(r.basis.ref_id)) {
        errors.push("basis 必须标明依据类型（receipt 或 substitution）与对应事件 ref_id");
      }
    }
    if ("claims" in r && !isNonEmptyArr(r.claims)) errors.push("claims 必须是非空数组");
    if ("claim_change_reason" in r && !isStr(r.claim_change_reason)) errors.push("菜单更新必须说明声明变化原因");
    return errors;
  },

  DEDUCTION_APPLIED(r) {
    const errors = missing(r, ["order_id", "batch_id", "amount", "reason", "linked_decision_id"]);
    if ("amount" in r && !isPosNum(r.amount)) errors.push("amount 必须是正数");
    return errors;
  },

  APPEAL_FILED(r) {
    return missing(r, ["target_decision_id", "contested_scope", "reason"]);
  },

  EVIDENCE_SUPPLEMENTED(r) {
    return missing(r, ["target_decision_id", "contested_scope", "evidence_ref"]);
  },
};

/** 负载级校验：只检查单条事件自身可判定的规则，跨事件约束见 ledger.js。 */
export function validatePayload(record) {
  const checker = checkers[record.event_type];
  return checker ? checker(record) : [];
}

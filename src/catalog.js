/**
 * 事件目录：每个事件类型归属的聚合、payload 必填字段与中文说明。
 *
 * 设计约定：
 * - 一个事件只能作用于一个聚合；version 在该聚合实例内从 1 递增。
 * - 必填字段只列跨机构交换时不可省的最小集合；其余字段放行，由业务规则解释。
 * - 指标阈值类字段统一为 [{ name, value, unit, source }]：
 *   source 取 "standard"（国家/行业标准）或 "contract"（采购合同），
 *   两者不一致时由 rules 提示差异并要求有权人员签署。
 */

export const EVENT_CATALOG = Object.freeze({
  TENDER_DEFINED: {
    aggregate: "purchase_contract",
    required: ["tender_id", "title", "product_requirements"],
    note: "登记招标定义（全谷物比例、品类范围、执行标准、营养声明上限等）",
  },
  CONTRACT_TERMS_EFFECTIVE: {
    aggregate: "purchase_contract",
    required: ["contract_no", "supplier_id", "effective_from", "effective_to", "terms_snapshot"],
    note: "保存某一时段有效的合同条款快照；订单只引用下单当时有效的版本",
  },
  ORDER_PLACED: {
    aggregate: "purchase_contract",
    required: ["order_no", "placed_at", "terms_version", "items"],
    note: "下单并冻结当时有效条款版本（terms_version）",
  },

  CATEGORY_REGISTERED: {
    aggregate: "supply_batch",
    required: ["sku", "category", "whole_grain_claim"],
    note: "登记产品类别与对外全谷物声明（如 全麦 / 杂粮）",
  },
  RECIPE_CERTIFIED: {
    aggregate: "supply_batch",
    required: ["recipe_id", "sku", "formula_version", "ingredient_certs"],
    note: "配方版本与原料证明登记；证明逐条注明可覆盖的批次范围",
  },
  PROCESS_INFO_REPORTED: {
    aggregate: "supply_batch",
    required: ["sku", "process_summary"],
    note: "加工信息：工艺、添加剂、生产线、加工日期",
  },
  BATCH_PRODUCED: {
    aggregate: "supply_batch",
    required: ["batch_no", "sku", "produced_at", "quantity"],
    note: "生产批次登记（一个 SKU 可有多个批次）",
  },
  SAMPLING_PLAN_SET: {
    aggregate: "supply_batch",
    required: ["batch_no", "plan"],
    note: "抽样方案：抽样点、数量、依据标准、检测项目",
  },
  SAMPLE_COLLECTED: {
    aggregate: "acceptance_sample",
    required: ["sample_no", "batch_no", "collected_at"],
    note: "按抽样方案抽取样品；样品与批次一一对应，结论不外推",
  },
  TEST_RESULT_RECORDED: {
    aggregate: "acceptance_sample",
    required: ["sample_no", "test_no", "issued_at", "conclusion", "items"],
    note: "检测结果，conclusion: qualified | unqualified | partial；仅覆盖该样品及其批次",
  },
  BATCH_DELIVERED: {
    aggregate: "supply_batch",
    required: ["batch_no", "order_no", "delivered_at", "delivered_quantity"],
    note: "到货：实际批次、数量与订单关联",
  },
  SUBSTITUTION_REQUESTED: {
    aggregate: "supply_batch",
    required: ["request_no", "order_no", "original_sku", "substitute_sku", "reason"],
    note: "缺货等原因提出替代申请（如杂粮饭料包替代原品类）",
  },
  SUBSTITUTION_APPROVED: {
    aggregate: "supply_batch",
    required: ["request_no", "approved_by", "approved_at", "claim_adjustment"],
    note: "有权人员批准替代，并给出营养/全谷物声明如何调整",
  },
  SUBSTITUTION_REJECTED: {
    aggregate: "supply_batch",
    required: ["request_no", "decided_by", "decided_at", "reason"],
    note: "驳回替代申请",
  },
  ACCEPTANCE_DECIDED: {
    aggregate: "supply_batch",
    required: ["batch_no", "decision", "decided_by", "decided_at"],
    note: "接收决定：accepted | rejected | partial_accepted | isolated_pending；可附签署与差异确认",
  },
  RETURN_EXCHANGE_RECORDED: {
    aggregate: "supply_batch",
    required: ["record_no", "batch_no", "type", "quantity", "reason"],
    note: "退换货：type=return | exchange；仅允许针对隔离/不合格范围",
  },
  DEDUCTION_RECORDED: {
    aggregate: "supply_batch",
    required: ["deduction_no", "order_no", "batch_no", "amount", "reason"],
    note: "扣款登记，须可沿批次追溯到接收决定与证据",
  },
  SUPPLEMENT_DOCUMENTED: {
    aggregate: "supply_batch",
    required: ["batch_no", "doc_type", "submitted_at"],
    note: "补证；只能影响尚未定案（finalized）的批次",
  },
  APPEAL_DECIDED: {
    aggregate: "supply_batch",
    required: ["batch_no", "appeal_no", "decided_by", "decided_at", "result"],
    note: "申诉裁决；只能改变尚未定案的范围",
  },

  MENU_RELEASED: {
    aggregate: "menu_release",
    required: ["menu_id", "serving_date", "items", "claims"],
    note: "菜单发布，附全谷物/营养承诺",
  },
  MENU_UPDATED: {
    aggregate: "menu_release",
    required: ["menu_id", "updated_at", "items", "claims", "change_reason"],
    note: "随实际接收或批准替代立即更新菜单，并说明声明为何变化",
  },
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

export const AGGREGATE_TYPES = Object.freeze([
  "purchase_contract",
  "supply_batch",
  "acceptance_sample",
  "menu_release",
]);

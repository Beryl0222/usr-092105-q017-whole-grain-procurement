/**
 * 验收决策规则。
 *
 * 两个入口：
 * - gate(event, stateBefore, config)：事件入库前的当场闸门，供供餐压力下给出“能不能接收/上菜/付款”的准确决定。
 * - audit(state, config)：对投影后的整体状态做全量稽核，返回 findings。
 *
 * finding：{ code, severity: "error" | "warning", subject, message, evidence }
 * - error：阻断（不得接收、不得发布、不得付款）
 * - warning：提示差异，必须由有权人员签署后才能放行
 */

import { apply, emptyState } from "./projection.js";

export const DEFAULT_CONFIG = Object.freeze({
  // 有权签署阈值差异/例外接收的岗位
  authorized_roles: Object.freeze(["采购主管", "食品安全管理员", "验收授权人"]),
  // 实际接收或替代批准后，菜单允许的最大延迟（分钟）
  menu_update_sla_minutes: 30,
});

function finding(code, severity, subject, message, evidence = {}) {
  return { code, severity, subject, message, evidence };
}

const msPerMinute = 60_000;

/* ------------------------------ 基础查询 ------------------------------ */

function latestDecision(batch) {
  return batch.decisions.length ? batch.decisions[batch.decisions.length - 1] : null;
}

function batchTests(state, batch) {
  return batch.sample_nos
    .map((no) => state.samples.get(no))
    .filter(Boolean)
    .flatMap((s) => s.tests.map((t) => ({ ...t, sample_no: s.sample_no, collected_at: s.collected_at })));
}

function batchIsFinalized(batch) {
  return batch.decisions.some((d) => d.finalized === true);
}

/** 该批次生产时采用的配方认证（BATCH_PRODUCED 指定 recipe_id，否则取生产前最近一次）。 */
function effectiveRecipe(state, batch) {
  const sku = state.skus.get(batch.sku);
  if (!sku) return null;
  if (batch.recipe_id) return sku.recipes.get(batch.recipe_id) ?? null;
  let hit = null;
  for (const id of sku.recipeOrder) {
    const recipe = sku.recipes.get(id);
    if (recipe && new Date(recipe.certified_at).getTime() <= new Date(batch.produced_at).getTime()) hit = recipe;
  }
  return hit;
}

/** 证明是否覆盖该批次：点名批次号，或生产日期落在覆盖区间；补证在未结案前可补足覆盖。 */
function certCoversBatch(cert, batch) {
  if (cert.covered_batch_nos?.includes(batch.batch_no)) return true;
  if (cert.produced_between) {
    const at = new Date(batch.produced_at).getTime();
    return at >= new Date(cert.produced_between.from).getTime() && at <= new Date(cert.produced_between.to).getTime();
  }
  return false;
}

/** 尚未定案批次补交的证明（注明补足的原证明编号），可修复原证明的批次错配。 */
function supplementCovers(batch, cert) {
  return batch.supplements.some((s) => s.doc_type === "ingredient_cert" && s.detail?.covers_cert_no === cert.cert_no);
}

function orderContext(state, batch) {
  const delivery = batch.deliveries[0];
  if (!delivery) return null;
  const order = state.orders.get(delivery.order_no);
  if (!order) return null;
  const contract = state.contracts.get(order.contract_id);
  return { delivery, order, contract };
}

/* --------------------------- 标准/合同阈值对比 --------------------------- */

/** 返回某合同某 SKU 标准阈值与合同阈值不一致的指标。 */
function thresholdMismatches(contract, sku) {
  if (!contract?.tender) return [];
  const req = contract.tender.product_requirements?.find((r) => r.sku === sku) ?? null;
  const standard = new Map((req?.metrics ?? []).map((m) => [m.name, m]));

  const out = [];
  for (const terms of contract.terms.values()) {
    for (const cm of terms.thresholds ?? []) {
      if (cm.sku !== sku) continue;
      const sm = standard.get(cm.name);
      if (!sm) continue;
      if (cm.min !== sm.min || cm.max !== sm.max) {
        out.push({ metric: cm.name, standard: sm, contract: { min: cm.min, max: cm.max, unit: cm.unit }, terms_version: terms.terms_version });
      }
    }
  }
  return out;
}

/* ------------------------------ 批次规则 ------------------------------ */

function checkBatch(state, batch, config) {
  const out = [];
  const sku = state.skus.get(batch.sku);
  const subject = batch.batch_no;

  if (!sku) {
    out.push(finding("BATCH_SKU_UNKNOWN", "error", subject, `批次 ${batch.batch_no} 的产品 ${batch.sku} 未登记类别`));
    return out;
  }

  // 1) 配方与原料证明必须覆盖“本批次”——本周面包问题：证明对应的是上一个生产批次
  const recipe = effectiveRecipe(state, batch);
  if (!recipe) {
    out.push(finding("RECIPE_MISSING", "error", subject, `批次 ${batch.batch_no} 缺少生产日期 ${batch.produced_at} 有效的配方认证`));
  } else {
    const uncovered = (recipe.ingredient_certs ?? []).filter((cert) => !certCoversBatch(cert, batch) && !supplementCovers(batch, cert));
    for (const cert of uncovered) {
      out.push(
        finding(
          "CERT_BATCH_MISMATCH",
          "error",
          subject,
          `原料证明 ${cert.cert_no}（${cert.ingredient}）不覆盖批次 ${batch.batch_no}，不得用作本批次接收依据`,
          { covers: cert.covered_batch_nos ?? cert.produced_between ?? null, recipe_id: recipe.recipe_id, formula_version: recipe.formula_version },
        ),
      );
    }
  }

  // 2) 检测结论只覆盖对应样品和批次
  const tests = batchTests(state, batch);
  if (batch.deliveries.length && tests.length === 0) {
    out.push(finding("TEST_MISSING", "warning", subject, `批次 ${batch.batch_no} 已到货但暂无本批次样品检测结果`));
  }
  for (const decision of batch.decisions) {
    for (const sampleNo of decision.based_on_samples ?? []) {
      const sample = state.samples.get(sampleNo);
      if (!sample) {
        out.push(finding("SAMPLE_MISSING", "error", subject, `接收决定引用了不存在的样品 ${sampleNo}`));
      } else if (sample.batch_no !== batch.batch_no) {
        out.push(
          finding("SAMPLE_SCOPE_LEAK", "error", subject, `样品 ${sampleNo} 取自批次 ${sample.batch_no}，检测结论不得外推到批次 ${batch.batch_no}`, { decision_at: decision.at }),
        );
      }
    }
  }

  const decision = latestDecision(batch);
  if (decision) {
    const qualified = tests.some((t) => t.conclusion === "qualified");
    const hasUnqualified = tests.some((t) => t.conclusion === "unqualified");
    const partial = tests.some((t) => t.conclusion === "partial");

    if ((decision.decision === "accepted" || decision.decision === "partial_accepted") && tests.length === 0) {
      out.push(finding("ACCEPT_WITHOUT_TEST", "error", subject, `批次 ${batch.batch_no} 作接收决定但没有本批次检测结果支撑`));
    }
    if (decision.decision === "accepted" && (hasUnqualified || partial) && !decision.threshold_signoff) {
      out.push(finding("ACCEPT_DESPITE_FAIL", "error", subject, `批次 ${batch.batch_no} 存在不合格/局部不合格检测项，不得整批接收；应隔离、补货或经批准改菜单`));
    }

    // 3) 局部不合格：不得无依据整批报废
    if (decision.decision === "rejected") {
      const fullyCovered = hasUnqualified && batch.plan && decision.scrap_basis;
      if (!decision.scrap_basis) {
        out.push(finding("SCRAP_WITHOUT_BASIS", "error", subject, `批次 ${batch.batch_no} 整批拒收/报废缺少依据；局部不合格只能隔离对应数量、补货或经批准改菜单`, { scrap_quantity: decision.scrap_quantity ?? null }));
      } else if (!hasUnqualified) {
        out.push(finding("SCRAP_WITHOUT_FAIL", "error", subject, `批次 ${batch.batch_no} 报废依据 ${decision.scrap_basis.doc_no ?? ""} 不对应任何不合格检测结论`));
      } else if (!batch.plan) {
        out.push(finding("SCRAP_SCOPE_UNPROVEN", "warning", subject, `批次 ${batch.batch_no} 缺少抽样方案，不合格检测能否代表全批无法证明`));
      } else if (decision.scrap_quantity && batch.quantity && decision.scrap_quantity < batch.quantity) {
        out.push(finding("SCRAP_PARTIAL_MARKED_FULL", "warning", subject, `报废数量小于批次总量却登记为整批拒收，请核对范围`));
      }
      void fullyCovered;
    }
    if (decision.decision === "partial_accepted") {
      const accounted = (decision.accepted_quantity ?? 0) + (decision.isolated_quantity ?? 0);
      if (batch.quantity && accounted > batch.quantity) {
        out.push(finding("QUANTITY_OVER_ACCOUNT", "error", subject, `接收+隔离数量 ${accounted} 超过批次数量 ${batch.quantity}`));
      }
      if (decision.isolated_quantity == null) {
        out.push(finding("ISOLATE_QTY_MISSING", "warning", subject, `局部接收未登记隔离数量`));
      }
    }

    // 4) 标准与合同阈值不一致 → 提示差异并要求有权人员签署
    const ctx = orderContext(state, batch);
    if (ctx) {
      const mismatches = thresholdMismatches(ctx.contract, batch.sku);
      if (mismatches.length && ["accepted", "partial_accepted"].includes(decision.decision)) {
        if (!decision.threshold_signoff) {
          out.push(
            finding("THRESHOLD_MISMATCH_UNSIGNED", "error", subject, `标准与合同阈值不一致（${mismatches.map((m) => m.metric).join("、")}），接收前须由有权人员签署`, { mismatches }),
          );
        } else if (!config.authorized_roles.includes(decision.threshold_signoff.role)) {
          out.push(
            finding("SIGNOFF_UNAUTHORIZED", "error", subject, `签署岗位 ${decision.threshold_signoff.role} 无权确认阈值差异`, { authorized_roles: config.authorized_roles }),
          );
        } else {
          out.push(finding("THRESHOLD_MISMATCH_SIGNED", "warning", subject, `阈值差异已经 ${decision.threshold_signoff.role} ${decision.threshold_signoff.by} 签署，按签署口径接收`, { mismatches }));
        }
      }
    }
  }

  // 5) 退换数量只能落在隔离/拒收范围
  const decided = latestDecision(batch);
  const allowedReturn = decided
    ? (decided.isolated_quantity ?? 0) + (decided.decision === "rejected" ? batch.quantity ?? 0 : 0)
    : 0;
  const returnedTotal = batch.returns.reduce((sum, r) => sum + (r.quantity ?? 0), 0);
  if (returnedTotal > allowedReturn) {
    out.push(finding("RETURN_SCOPE_EXCEEDED", "error", subject, `退换数量 ${returnedTotal} 超过已隔离/拒收范围 ${allowedReturn}，合格部分不得自行退回`));
  }

  return out;
}

/* ------------------------------ 替代规则 ------------------------------ */

function checkSubstitution(state, request) {
  const out = [];
  if (request.status !== "approved" && request.status !== "rejected") return out;

  const order = state.orders.get(request.order_no);
  if (!order) {
    out.push(finding("SUB_ORDER_MISSING", "error", request.request_no, `替代申请 ${request.request_no} 对应订单 ${request.order_no} 不存在`));
    return out;
  }
  if (request.status === "approved") {
    if (!request.claim_adjustment?.new_claim) {
      out.push(finding("SUB_CLAIM_UNCHANGED", "error", request.request_no, `替代 ${request.original_sku}→${request.substitute_sku} 已批准但未给出新的全谷物/营养声明口径，菜单不得沿用原承诺`));
    }
    const subSku = state.skus.get(request.substitute_sku);
    if (!subSku) {
      out.push(finding("SUB_SKU_UNREGISTERED", "error", request.request_no, `替代品 ${request.substitute_sku} 未登记产品类别与声明`));
    }
  }
  return out;
}

/* ------------------------------ 菜单规则 ------------------------------ */

function orderNoOfMenuItem(state, item) {
  return item.order_no ?? null;
}

function checkMenu(state, menu, config) {
  const out = [];
  const slaMs = config.menu_update_sla_minutes * msPerMinute;

  for (const item of menu.items ?? []) {
    const orderNo = orderNoOfMenuItem(state, item);
    // 已批准替代：菜单不得仍以原 SKU、原声明上菜
    for (const request of state.requests.values()) {
      if (request.status !== "approved" || request.order_no !== orderNo) continue;
      if (item.sku === request.original_sku) {
        out.push(
          finding("MENU_CLAIM_STALE", "error", menu.menu_id, `菜单仍按原品类 ${request.original_sku} 展示，但该订单已批准替代为 ${request.substitute_sku}；须立即更新并说明声明变化`, { request_no: request.request_no }),
        );
      }
      if (item.sku === request.substitute_sku) {
        const expected = request.claim_adjustment?.new_claim;
        if (expected && item.claim !== expected) {
          out.push(finding("MENU_CLAIM_MISMATCH", "error", menu.menu_id, `替代菜品声明应为“${expected}”，菜单当前为“${item.claim ?? "未标注"}”`, { request_no: request.request_no }));
        }
      }
    }

    // 未替代：菜单声明须与登记的产品全谷物声明一致
    const sku = state.skus.get(item.sku);
    if (sku && sku.whole_grain_claim && item.claim && item.claim !== sku.whole_grain_claim) {
      const overridden = [...state.requests.values()].some(
        (r) => r.status === "approved" && r.order_no === orderNo && r.substitute_sku === item.sku,
      );
      if (!overridden) {
        out.push(finding("MENU_CLAIM_VS_PRODUCT", "error", menu.menu_id, `菜单“${item.name ?? item.sku}”声明“${item.claim}”与产品登记声明“${sku.whole_grain_claim}”不符`));
      }
    }
  }

  // 时效性：实际接收或替代批准后，菜单必须在 SLA 内更新并给出 change_reason
  const triggers = [];
  for (const item of menu.items ?? []) {
    const orderNo = orderNoOfMenuItem(state, item);
    for (const batch of state.batches.values()) {
      const hit = batch.deliveries.some((d) => d.order_no === orderNo) || item.batch_no === batch.batch_no;
      if (!hit) continue;
      const decision = latestDecision(batch);
      if (decision && ["accepted", "partial_accepted"].includes(decision.decision)) triggers.push({ at: decision.at, why: `批次 ${batch.batch_no} 接收` });
    }
    for (const request of state.requests.values()) {
      if (request.status === "approved" && request.order_no === orderNo) {
        triggers.push({ at: request.approved_at, why: `替代 ${request.request_no} 批准` });
      }
    }
  }
  // 也覆盖“旧菜单仍挂原品”的情形：触发来源按订单号匹配，即使更新后菜单已换成新品
  for (const request of state.requests.values()) {
    if (request.status !== "approved") continue;
    if ((menu.items ?? []).some((i) => orderNoOfMenuItem(state, i) === request.order_no)) {
      triggers.push({ at: request.approved_at, why: `替代 ${request.request_no} 批准` });
    }
  }

  if (triggers.length) {
    const latestTrigger = triggers.map((t) => new Date(t.at).getTime()).reduce((a, b) => Math.max(a, b));
    // 变化后无论是更新还是重新发布，只要有不早于触发点的版本即视为已响应
    const publications = menu.history.map((h) => ({ at: new Date(h.at).getTime(), kind: h.kind, reason: h.change_reason }));
    const latestPub = publications.map((h) => h.at).reduce((a, b) => Math.max(a, b), 0);
    if (latestPub < latestTrigger) {
      out.push(finding("MENU_NOT_UPDATED", "error", menu.menu_id, `存在${new Date(latestTrigger).toISOString()} 的接收/替代变化，当天菜单尚未更新`));
    } else if (latestPub - latestTrigger > slaMs) {
      out.push(finding("MENU_UPDATE_LATE", "error", menu.menu_id, `菜单更新滞后 ${Math.round((latestPub - latestTrigger) / msPerMinute)} 分钟，超过 ${config.menu_update_sla_minutes} 分钟上限`));
    }
    const covering = publications.find((h) => h.at >= latestTrigger && h.kind === "updated");
    if (covering && !covering.reason) {
      out.push(finding("MENU_REASON_MISSING", "warning", menu.menu_id, `菜单已更新但未说明声明为何变化`));
    }
  }

  return out;
}

/* ------------------------------ 付款追溯 ------------------------------ */

function checkDeduction(state, rec) {
  const out = [];
  const order = state.orders.get(rec.order_no);
  if (!order) {
    out.push(finding("PAY_ORDER_MISSING", "error", rec.deduction_no, `扣款 ${rec.deduction_no} 找不到订单 ${rec.order_no}，付款链断裂`));
    return out;
  }
  const batch = state.batches.get(rec.batch_no);
  if (!batch) {
    out.push(finding("PAY_BATCH_MISSING", "error", rec.deduction_no, `扣款 ${rec.deduction_no} 找不到批次 ${rec.batch_no}`));
    return out;
  }
  if (!batch.deliveries.some((d) => d.order_no === rec.order_no)) {
    out.push(finding("PAY_CHAIN_BROKEN", "error", rec.deduction_no, `批次 ${rec.batch_no} 未向订单 ${rec.order_no} 到货，扣款无法沿订单→批次追溯`));
  }
  const tests = batchTests(state, batch);
  if (tests.length === 0) {
    out.push(finding("PAY_NO_SAMPLE", "error", rec.deduction_no, `扣款缺少样品检测证据：批次 ${rec.batch_no} 无样品/检测结果`));
  }
  const decision = latestDecision(batch);
  if (!decision) {
    out.push(finding("PAY_NO_DECISION", "error", rec.deduction_no, `扣款缺少接收决定：批次 ${rec.batch_no} 尚未定案`));
  } else if (decision.decision === "accepted" && !decision.isolated_quantity) {
    out.push(finding("PAY_DEDUCT_FROM_ACCEPTED", "error", rec.deduction_no, `批次 ${rec.batch_no} 已整批合格接收，对其扣款无依据`));
  }

  const delivered = batch.deliveries.filter((d) => d.order_no === rec.order_no).reduce((s, d) => s + (d.delivered_quantity ?? 0), 0);
  const accepted = batch.decisions
    .filter((d) => ["accepted", "partial_accepted"].includes(d.decision))
    .reduce((s, d) => s + (d.accepted_quantity ?? (d.decision === "accepted" ? delivered : 0)), 0);
  const claimable = Math.max(0, delivered - accepted);
  if (rec.quantity != null && rec.quantity > claimable) {
    out.push(finding("PAY_QTY_EXCEEDED", "error", rec.deduction_no, `扣款数量 ${rec.quantity} 超过未接收数量 ${claimable}（到货 ${delivered}、接收 ${accepted}）`));
  }
  return out;
}

/* ------------------------------ 定案锁定 ------------------------------ */

/** 事件入库闸门：在“应用该事件之前”的状态上判断。 */
export function gate(event, stateBefore, config = DEFAULT_CONFIG) {
  const state = stateBefore ?? emptyState();
  const p = event.payload ?? {};

  switch (event.event_type) {
    case "ORDER_PLACED": {
      const contract = state.contracts.get(event.aggregate_id);
      const terms = contract?.terms.get(p.terms_version);
      if (!contract) return [finding("ORDER_NO_CONTRACT", "error", p.order_no, `下单时合同 ${event.aggregate_id} 尚未建档`)];
      if (!terms) return [finding("ORDER_TERMS_UNKNOWN", "error", p.order_no, `条款版本 ${p.terms_version} 不存在，无法冻结下单当时有效条款`)];
      const at = new Date(p.placed_at).getTime();
      if (at < new Date(terms.effective_from).getTime() || at > new Date(terms.effective_to).getTime()) {
        return [finding("ORDER_TERMS_NOT_EFFECTIVE", "error", p.order_no, `条款版本 ${p.terms_version} 在下单时间 ${p.placed_at} 未生效（有效期 ${terms.effective_from} 至 ${terms.effective_to}）`)];
      }
      return [];
    }
    case "BATCH_DELIVERED": {
      const batch = state.batches.get(p.batch_no);
      if (!batch) return [finding("DELIVERY_BATCH_UNKNOWN", "error", p.batch_no, `到货批次 ${p.batch_no} 未登记生产`)];
      if (!state.orders.has(p.order_no)) {
        return [finding("DELIVERY_ORDER_UNKNOWN", "error", p.batch_no, `到货对应订单 ${p.order_no} 不存在`)];
      }
      if (p.against_request_no) {
        const request = state.requests.get(p.against_request_no);
        if (!request || request.status !== "approved") {
          return [finding("DELIVERY_SUB_NOT_APPROVED", "error", p.batch_no, `替代供货引用的申请 ${p.against_request_no} 尚未批准，食堂不得按替代品接收`)];
        }
        if (request.substitute_sku && batch.sku && request.substitute_sku !== batch.sku) {
          return [finding("DELIVERY_SUB_SKU_MISMATCH", "error", p.batch_no, `到货批次属于 ${batch.sku}，与批准的替代品 ${request.substitute_sku} 不符`)];
        }
      }
      return [];
    }
    case "SUPPLEMENT_DOCUMENTED": {
      const batch = state.batches.get(p.batch_no);
      if (batch && batchIsFinalized(batch)) {
        return [finding("SUPPLEMENT_AFTER_FINALIZED", "error", p.batch_no, `批次 ${p.batch_no} 已定案，补证只能改变尚未定案的范围`)];
      }
      return [];
    }
    case "APPEAL_DECIDED": {
      const batch = state.batches.get(p.batch_no);
      if (batch && batchIsFinalized(batch)) {
        return [finding("APPEAL_AFTER_FINALIZED", "error", p.batch_no, `批次 ${p.batch_no} 已定案，申诉只能改变尚未定案的范围`)];
      }
      return [];
    }
    case "DEDUCTION_RECORDED":
      return checkDeduction(state, { at: event.occurred_at, ...p });
    default:
      return [];
  }
}

/* ------------------------------ 全量稽核 ------------------------------ */

export function audit(state, config = DEFAULT_CONFIG) {
  const findings = [];

  // 订单下单时引用的条款须真实有效
  for (const [contractId, contract] of state.contracts) {
    for (const order of contract.orders.values()) {
      const terms = contract.terms.get(order.terms_version);
      if (!terms) {
        findings.push(finding("ORDER_TERMS_UNKNOWN", "error", order.order_no, `订单引用的条款版本 ${order.terms_version} 在合同 ${contractId} 中不存在`));
        continue;
      }
      const at = new Date(order.placed_at).getTime();
      if (at < new Date(terms.effective_from).getTime() || at > new Date(terms.effective_to).getTime()) {
        findings.push(finding("ORDER_TERMS_NOT_EFFECTIVE", "error", order.order_no, `订单冻结的条款在 ${order.placed_at} 未生效`));
      }
    }
  }

  for (const batch of state.batches.values()) findings.push(...checkBatch(state, batch, config));
  for (const request of state.requests.values()) findings.push(...checkSubstitution(state, request));
  for (const menu of state.menus.values()) findings.push(...checkMenu(state, menu, config));
  for (const rec of state.deductions) findings.push(...checkDeduction(state, rec));

  return findings;
}

/** 便捷入口：边回放边执行入库闸门，再对最终状态稽核；返回全部 findings。 */
export function replay(events, config = DEFAULT_CONFIG) {
  const state = emptyState();
  const findings = [];
  for (const event of events) {
    findings.push(...gate(event, state, config));
    apply(state, event);
  }
  findings.push(...audit(state, config));
  return { state, findings };
}

/**
 * 投影：把事件流折叠成验收决策所需的当前状态。
 * 投影只认事实、不做合规判断；所有规则在 rules.js 中。
 * 所有索引均通过 payload 中的业务标识（batch_no / sample_no / order_no / request_no / menu_id）关联。
 */

export function emptyState() {
  return {
    contracts: new Map(), // aggregate_id(合同号) -> {tender, terms:Map(version), orders:Map(order_no)}
    orders: new Map(), // order_no -> {contract_id, placed_at, terms_version, items}
    skus: new Map(), // sku -> {category, whole_grain_claim, recipes:Map(recipe_id -> 认证，按时间追加), recipeOrder:[], process:[]}
    batches: new Map(), // batch_no -> 批次状态
    samples: new Map(), // sample_no -> {batch_no, collected_at, tests:[]}
    requests: new Map(), // request_no -> 替代申请状态
    menus: new Map(), // menu_id -> 菜单当前状态与历史
    deductions: [], // 全部扣款
    events: [],
  };
}

function ensure(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

export function apply(state, event) {
  state.events.push(event);
  const p = event.payload ?? {};

  switch (event.event_type) {
    case "TENDER_DEFINED": {
      const contract = ensure(state.contracts, event.aggregate_id, () => ({ tender: null, terms: new Map(), orders: new Map() }));
      contract.tender = { at: event.occurred_at, ...p };
      break;
    }
    case "CONTRACT_TERMS_EFFECTIVE": {
      const contract = ensure(state.contracts, event.aggregate_id, () => ({ tender: null, terms: new Map(), orders: new Map() }));
      const version = p.terms_snapshot?.terms_version ?? `terms-${contract.terms.size + 1}`;
      contract.terms.set(version, {
        contract_no: p.contract_no,
        supplier_id: p.supplier_id,
        effective_from: p.effective_from,
        effective_to: p.effective_to,
        ...p.terms_snapshot,
        terms_version: version,
      });
      break;
    }
    case "ORDER_PLACED": {
      const contract = ensure(state.contracts, event.aggregate_id, () => ({ tender: null, terms: new Map(), orders: new Map() }));
      const order = { order_no: p.order_no, contract_id: event.aggregate_id, placed_at: p.placed_at, terms_version: p.terms_version, items: p.items ?? [] };
      contract.orders.set(p.order_no, order);
      state.orders.set(p.order_no, order);
      break;
    }

    case "CATEGORY_REGISTERED": {
      const sku = ensure(state.skus, p.sku, () => ({ category: null, whole_grain_claim: null, recipes: new Map(), recipeOrder: [], process: [] }));
      sku.category = p.category;
      sku.whole_grain_claim = p.whole_grain_claim;
      break;
    }
    case "RECIPE_CERTIFIED": {
      const sku = ensure(state.skus, p.sku, () => ({ category: null, whole_grain_claim: null, recipes: new Map(), recipeOrder: [], process: [] }));
      sku.recipes.set(p.recipe_id, { recipe_id: p.recipe_id, formula_version: p.formula_version, ingredient_certs: p.ingredient_certs ?? [], certified_at: event.occurred_at });
      sku.recipeOrder.push(p.recipe_id);
      break;
    }
    case "PROCESS_INFO_REPORTED": {
      const sku = ensure(state.skus, p.sku, () => ({ category: null, whole_grain_claim: null, recipes: new Map(), recipeOrder: [], process: [] }));
      sku.process.push({ at: event.occurred_at, summary: p.process_summary });
      break;
    }

    case "BATCH_PRODUCED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.sku = p.sku;
      batch.produced_at = p.produced_at;
      batch.quantity = p.quantity;
      batch.recipe_id = p.recipe_id ?? batch.recipe_id;
      break;
    }
    case "SAMPLING_PLAN_SET": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.plan = { at: event.occurred_at, ...p.plan };
      break;
    }
    case "BATCH_DELIVERED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.deliveries.push({
        order_no: p.order_no,
        at: event.occurred_at,
        delivered_quantity: p.delivered_quantity,
        against_request_no: p.against_request_no ?? null,
      });
      break;
    }
    case "SUBSTITUTION_REQUESTED": {
      state.requests.set(p.request_no, {
        request_no: p.request_no,
        order_no: p.order_no,
        original_sku: p.original_sku,
        substitute_sku: p.substitute_sku,
        reason: p.reason,
        requested_at: event.occurred_at,
        status: "requested",
      });
      break;
    }
    case "SUBSTITUTION_APPROVED": {
      const request = ensure(state.requests, p.request_no, () => ({ request_no: p.request_no }));
      Object.assign(request, {
        status: "approved",
        approved_by: p.approved_by,
        approved_at: p.approved_at,
        claim_adjustment: p.claim_adjustment,
      });
      break;
    }
    case "SUBSTITUTION_REJECTED": {
      const request = ensure(state.requests, p.request_no, () => ({ request_no: p.request_no }));
      Object.assign(request, { status: "rejected", decided_by: p.decided_by, decided_at: p.decided_at, reject_reason: p.reason });
      break;
    }
    case "ACCEPTANCE_DECIDED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.decisions.push({
        at: event.occurred_at,
        decision: p.decision,
        decided_by: p.decided_by,
        based_on_samples: p.based_on_samples ?? [],
        accepted_quantity: p.accepted_quantity,
        isolated_quantity: p.isolated_quantity,
        scrap_quantity: p.scrap_quantity,
        scrap_basis: p.scrap_basis,
        finalized: p.finalized === true,
        threshold_signoff: p.threshold_signoff ?? null,
        note: p.note ?? null,
      });
      break;
    }
    case "RETURN_EXCHANGE_RECORDED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.returns.push({ at: event.occurred_at, type: p.type, quantity: p.quantity, reason: p.reason, record_no: p.record_no });
      break;
    }
    case "DEDUCTION_RECORDED": {
      const record = {
        deduction_no: p.deduction_no,
        order_no: p.order_no,
        batch_no: p.batch_no,
        amount: p.amount,
        quantity: p.quantity ?? null,
        reason: p.reason,
        at: event.occurred_at,
      };
      state.deductions.push(record);
      if (state.batches.has(p.batch_no)) state.batches.get(p.batch_no).deductions.push(record);
      break;
    }
    case "SUPPLEMENT_DOCUMENTED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.supplements.push({ at: event.occurred_at, doc_type: p.doc_type, detail: p.detail ?? null });
      break;
    }
    case "APPEAL_DECIDED": {
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.appeals.push({ at: event.occurred_at, appeal_no: p.appeal_no, decided_by: p.decided_by, result: p.result, note: p.reason ?? null });
      break;
    }

    case "SAMPLE_COLLECTED": {
      state.samples.set(p.sample_no, { sample_no: p.sample_no, batch_no: p.batch_no, collected_at: p.collected_at, tests: [] });
      const batch = ensure(state.batches, p.batch_no, () => newBatch(p.batch_no));
      batch.sample_nos.push(p.sample_no);
      break;
    }
    case "TEST_RESULT_RECORDED": {
      const sample = ensure(state.samples, p.sample_no, () => ({ sample_no: p.sample_no, batch_no: null, collected_at: null, tests: [] }));
      sample.tests.push({ test_no: p.test_no, issued_at: p.issued_at, conclusion: p.conclusion, items: p.items ?? [] });
      break;
    }

    case "MENU_RELEASED": {
      state.menus.set(p.menu_id, {
        menu_id: p.menu_id,
        serving_date: p.serving_date,
        released_at: event.occurred_at,
        items: p.items ?? [],
        claims: p.claims ?? [],
        history: [{ at: event.occurred_at, kind: "released", items: p.items ?? [], claims: p.claims ?? [], change_reason: null }],
      });
      break;
    }
    case "MENU_UPDATED": {
      const menu = ensure(state.menus, p.menu_id, () => ({ menu_id: p.menu_id, history: [] }));
      menu.serving_date = p.serving_date ?? menu.serving_date;
      menu.items = p.items ?? [];
      menu.claims = p.claims ?? [];
      menu.history.push({ at: p.updated_at ?? event.occurred_at, kind: "updated", items: menu.items, claims: menu.claims, change_reason: p.change_reason });
      break;
    }
    default:
      break;
  }
  return state;
}

function newBatch(batch_no) {
  return {
    batch_no,
    sku: null,
    produced_at: null,
    quantity: null,
    recipe_id: null,
    plan: null,
    sample_nos: [],
    deliveries: [],
    decisions: [],
    returns: [],
    deductions: [],
    supplements: [],
    appeals: [],
  };
}

export function project(events) {
  return events.reduce((state, event) => apply(state, event), emptyState());
}

/** 截至某时刻的投影（用于回放“供餐压力下当场应给出什么决定”）。 */
export function projectAsOf(events, asOf) {
  const cutoff = new Date(asOf).getTime();
  return project(events.filter((e) => new Date(e.occurred_at).getTime() <= cutoff));
}

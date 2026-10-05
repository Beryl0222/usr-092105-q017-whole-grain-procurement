# 全谷物集采验收

本项目保存“全谷物集采验收”领域中跨机构交换记录的基础约定，供采购中心、供应商与学校在供餐压力下交换事实、作出可追溯的验收决定。

## 业务对象与事件

供应商和学校通过四类业务对象上报事件，事件类型与对象的对应关系由 `src/validator.js` 强制：

- `purchase_contract`：招标定义（`TENDER_DEFINED`）、订单当时有效条款快照（`TERMS_LOCKED`）、替代申请与批准（`SUBSTITUTION_REQUESTED` / `SUBSTITUTION_APPROVED`）、扣款（`DEDUCTION_APPLIED`）、申诉与补证（`APPEAL_FILED` / `EVIDENCE_SUPPLEMENTED`）。
- `supply_batch`：到货（`BATCH_DELIVERED`，含产品类别、配方与原料证明、加工信息、生产批次、到货数量）、验收决定（`ACCEPTANCE_DECIDED`）、食堂接收（`RECEIPT_CONFIRMED`）、退换（`RETURN_RECORDED`）。
- `acceptance_sample`：抽样方案（`SAMPLING_PLAN_ISSUED`）、抽样（`SAMPLE_COLLECTED`）、检测结果（`TEST_RESULT_RECORDED`）。
- `menu_release`：当天菜单发布（`MENU_UPDATED`）。

## 关键规则

单条事件负载规则见 `src/payloads.js`，跨事件流转约束见 `src/ledger.js`：

1. 招标定义与订单当时有效条款先存档，后续到货、检测、验收均沿订单追溯。
2. 到货时配方证明必须对应当前生产批次，证明错批次的到货登记会被拒绝。
3. 检测结论只覆盖对应样品和批次（`conclusion_scope` 固定为 `sample_and_batch_only`），验收决定引用其他批次的样品会被拒绝，不可外推全部产品。
4. 标准与合同阈值结论不一致时，验收决定必须记录差异说明并由有权人员签署。
5. 局部不合格只允许隔离、补货、经批准改菜单等按范围的处置；整批报废必须给出覆盖整批的依据。
6. 当天菜单必须随实际接收或批准替代立即更新，并说明声明为何变化。
7. 补证或申诉只能改变尚未定案的范围；决定一旦显式定案或被扣款引用即不可再变更。
8. 付款审核用 `traceOrder(events, orderId)` 沿订单追到批次、样品、验收决定、接收与扣款。

## 领域资料

- `contracts/domain.schema.json`：事件信封与本领域允许的聚合、事件类型。
- `data/sample.json`：一条可用于本地联调的中文样例。
- `data/scenarios/whole-wheat-bread.json`：全麦面包检测值达国标未达合同阈值，差异签署接收、当天更新菜单、扣款定案的完整事件流。
- `data/scenarios/multigrain-substitution.json`：供应商缺货经批准换成杂粮饭料包、菜单声明同步调整的完整事件流。
- `src/`：信封校验（`validator.js`）、负载规则（`payloads.js`）、事件流约束与付款追溯（`ledger.js`）。
- `tests/`：验证样例、公共字段约定与上述关键规则。

事件由 `event_id` 唯一标识，`aggregate_id` 指向业务对象，`version` 从 1 开始递增，`occurred_at` 保留真实发生时间。来源系统重试时必须沿用原事件标识。

## 本地检查

运行 `node --test`。

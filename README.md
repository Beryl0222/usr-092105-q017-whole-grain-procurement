# 全谷物集采验收

保存“学校食堂全谷物集采验收”领域中跨机构交换的事实与判定规则。系统基于事件溯源：供应商与学校继续通过 `purchase_contract`、`supply_batch`、`acceptance_sample`、`menu_release` 四类聚合上报事件；系统先保存招标定义与“订单当时有效条款”，再把产品类别、配方与原料证明、加工信息、生产批次、抽样方案、检测结果、到货数量、替代申请、食堂接收、菜单发布、退换及扣款串到实际供货上，在供餐压力下给出可执行的接收/放行/付款决定。

## 本周两个实际问题如何被拦截

1. **全麦面包外包装标“全麦”，配方证明对应的是上一个生产批次（B20260920-BRD）。**
   原料证明逐条标注覆盖批次；本批次 `B20261005-BRD` 到货时系统给出 `CERT_BATCH_MISMATCH` 阻断，不得用旧批次证明接收。供应商在批次**未定案**前补交覆盖本批次的 `CERT-FLR-20261002` 后，方可结合本批次合格检测接收。
2. **杂粮米缺货，供应商申请换杂粮饭料包，菜单仍展示“全谷物≥50%”。**
   替代必须经 `SUBSTITUTION_APPROVED`，批准时强制给出新声明（料包为“全谷物≥30%”）；菜单仍挂原品类/原承诺会被 `MENU_CLAIM_STALE`、`MENU_NOT_UPDATED` 双重阻断。料包水分局部不合格时只隔离对应 20 份、换货并据实扣款，不整批报废。

完整事件序列见 `data/scenario.json`，可用 `npm run replay` 回放。

## 领域规则（系统强制）

- **条款冻结**：订单只引用下单时处于有效期内的条款版本；招标标准与合同阈值同时保存。
- **检测范围**：检测结论只覆盖对应样品及其批次；接收决定引用别的批次样品 → `SAMPLE_SCOPE_LEAK`，不得外推全部产品。
- **阈值差异**：标准与合同阈值不一致时给出差异提示，必须由有权岗位（采购主管/食品安全管理员/验收授权人）签署；未签署 `THRESHOLD_MISMATCH_UNSIGNED` 阻断，越权 `SIGNOFF_UNAUTHORIZED` 阻断，签署后保留 `THRESHOLD_MISMATCH_SIGNED` 警示留痕。
- **局部不合格**：可隔离、补货（换货）或经批准改菜单；无依据整批报废 → `SCRAP_WITHOUT_BASIS`；退换数量不得超过隔离/拒收范围 → `RETURN_SCOPE_EXCEEDED`。
- **菜单时效**：实际接收或替代批准后，当天菜单必须立即（默认 30 分钟内）更新，并在 `change_reason` 说明声明为何变化；否则 `MENU_NOT_UPDATED` / `MENU_UPDATE_LATE` / `MENU_REASON_MISSING`。
- **付款追溯**：扣款沿 订单 → 到货批次 → 样品检测 → 接收决定 追溯；整批合格接收后扣款 `PAY_DEDUCT_FROM_ACCEPTED`、超过未接收数量 `PAY_QTY_EXCEEDED` 均阻断。
- **定案锁定**：`finalized: true` 后补证与申诉被闸门拒绝（`SUPPLEMENT_AFTER_FINALIZED` / `APPEAL_AFTER_FINALIZED`）；补证、申诉只能改变尚未定案的范围。

## 文件

- `contracts/domain.schema.json`：事件信封与允许的事件/聚合类型（payload 必填字段见 `src/catalog.js`）。
- `src/catalog.js`：事件目录——事件类型归属的聚合与 payload 必填字段。
- `src/validator.js`：信封与事件流校验（必填、聚合归属、版本连续、event_id 不重复）。
- `src/projection.js`：把事件流投影成合同/订单/SKU/批次/样品/替代申请/菜单/扣款状态。
- `src/rules.js`：入库闸门 `gate`、全量稽核 `audit`、边回放边判定的 `replay`。
- `src/replay.js`：场景回放 CLI，按 `data/scenario.json` 的预期断言退出码。
- `data/sample.json`：单条信封联调样例；`data/scenario.json`：本周完整场景与检查点。
- `tests/`：信封校验与全部领域规则测试。

事件由 `event_id` 唯一标识，`aggregate_id` 指向业务对象，同一聚合内 `version` 从 1 递增，`occurred_at` 保留真实发生时间。来源系统重试必须沿用原事件标识。

## 本地检查

```bash
node --test        # 16 项规则测试
npm run replay     # 回放本周场景：headline 零阻断（1 项已签署警示），负向案例产生预期阻断
```

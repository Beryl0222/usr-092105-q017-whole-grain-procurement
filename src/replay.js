#!/usr/bin/env node
/**
 * 场景回放 CLI：
 *   node src/replay.js data/scenario.json
 * 输出每条事件流的阻断(error)/警示(warning)，以及检查点结论。
 * 退出码：存在任何 error 时为 1，供验收台/CI 直接使用。
 */

import { readFile } from "node:fs/promises";

import { projectAsOf } from "./projection.js";
import { audit, replay } from "./rules.js";
import { validateStream } from "./validator.js";

function printFindings(findings) {
  for (const f of findings) {
    const tag = f.severity === "error" ? "阻断" : "警示";
    console.log(`  [${tag}] ${f.code} @ ${f.subject}: ${f.message}`);
  }
}

async function main(file) {
  const data = JSON.parse(await readFile(file, "utf8"));
  let mismatch = false;

  for (const [name, events] of Object.entries(data.streams ?? {})) {
    console.log(`\n=== 事件流：${name}（${events.length} 条事件）===`);
    const envelopeErrors = validateStream(events);
    if (envelopeErrors.length) {
      mismatch = true;
      console.log("信封校验失败：");
      for (const e of envelopeErrors) console.log(`  [阻断] ${e}`);
      continue;
    }

    const { findings } = replay(events);
    const errors = findings.filter((f) => f.severity === "error");
    const warnings = findings.filter((f) => f.severity === "warning");
    printFindings(findings);
    console.log(`结论：${errors.length} 项阻断，${warnings.length} 项警示`);

    const expect = data.final_expect?.[name];
    if (expect) {
      const got = { error: new Set(errors.map((f) => f.code)), warning: new Set(warnings.map((f) => f.code)) };
      const missing = [...(expect.error_codes ?? [])].filter((c) => !got.error.has(c));
      const unexpected = [...got.error].filter((c) => !(expect.error_codes ?? []).includes(c));
      const missingWarn = [...(expect.warning_codes ?? [])].filter((c) => !got.warning.has(c));
      if (missing.length || unexpected.length || missingWarn.length) {
        mismatch = true;
        if (missing.length) console.log(`与预期不符，缺少阻断：${missing.join(", ")}`);
        if (unexpected.length) console.log(`与预期不符，出现意外阻断：${unexpected.join(", ")}`);
        if (missingWarn.length) console.log(`与预期不符，缺少警示：${missingWarn.join(", ")}`);
      } else {
        console.log("与场景预期一致");
      }
    }
  }

  for (const cp of data.checkpoints ?? []) {
    const events = data.streams[cp.stream];
    const state = projectAsOf(events, cp.as_of);
    const codes = new Set(audit(state).map((f) => f.code));
    const missing = cp.expect_codes.filter((code) => !codes.has(code));
    console.log(`\n=== 检查点 ${cp.stream} @ ${cp.as_of} ===`);
    console.log(cp.note);
    if (missing.length) {
      mismatch = true;
      console.log(`未按预期出现：${missing.join(", ")}`);
    } else {
      console.log(`已出现预期结论：${cp.expect_codes.join(", ")}`);
    }
  }

  console.log(mismatch ? "\n回放结论：与场景预期不符" : "\n回放结论：全部符合场景预期（阻断项来自负向案例，用于证明系统会拦截）");
  process.exitCode = mismatch ? 1 : 0;
}

const file = process.argv[2] ?? "data/scenario.json";
main(file).catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
